// The Kilo plugin, in one of three modes per directory (the decision is cached):
// - outside git: no hooks at all;
// - an untracked git repo: near-zero cost. In-memory nudge, plus one tool, `hafiz_track_project`,
//   for primary agents. Calling it runs `hafiz init` and switches this instance to managed mode
//   immediately (see `untrackedHooks`);
// - a tracked repo: installs config, registers the Hafiz tools (plugin-native, resolved per
//   calling session), observes sessions, captures subagent reports and shapes requests through
//   the selected RequestShaper.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Actor,
  agentRoleNames,
  type Config,
  configDirs,
  defaultStoreRoot,
  findPointerFile,
  loadConfig,
  type ResolvedProject,
  resolveProject,
  userConfigDir,
  worktreeOf,
} from '@hafiz/core'
import { type DaemonClient, ensureDaemon, initProject } from '@hafiz/gateway-mcp'
import { toolCounters, USER_TURN_COUNTERS } from './counters.js'
import { installConfig } from './install.js'
import type {
  Hooks,
  KiloEvent,
  KiloMessageWithParts,
  Plugin,
  PluginInput,
  PluginOptions,
} from './kilo.js'
import { condenserSystemHook, installCondenserAgent, kiloRelayHandler, usesKiloLlm } from './llm.js'
import { createNudgeHooks } from './nudge.js'
import { SessionRegistry } from './sessions.js'
import { ConversationShaper } from './shaper/core.js'
import { TransformHooksShaper } from './shaper/hooks.js'
import { EmbeddedProxy, SESSION_HEADER } from './shaper/proxy.js'
import type { ShaperSetting } from './shaper/types.js'
import { HafizToolError, nativeTools, TRACK_TOOL, trackTool } from './tools.js'

export interface HafizPluginDeps {
  env?: NodeJS.ProcessEnv
  /** Replace daemon discovery (tests run the daemon in-process). */
  connect?: (project: ResolvedProject) => Promise<DaemonClient>
  /** argv prefix that runs the hafiz CLI; default: node + @hafiz/cli's bin.js. */
  hafiz?: string[]
  /** Delay before the session.idle fallback captures a report (ms). */
  reportFallbackMs?: number
  log?: (line: string) => void
  /** Bypass the per-directory detection cache (tests). */
  noCache?: boolean
}

type Detected =
  | { kind: 'tracked'; project: ResolvedProject; config: Config }
  | { kind: 'untracked'; worktree: string; config: Config }

const detection = new Map<string, Detected | null>()

function detect(dir: string, env: NodeJS.ProcessEnv, log: (l: string) => void, cache: boolean) {
  if (cache && detection.has(dir)) return detection.get(dir) ?? null
  let found: Detected | null = null
  try {
    if (findPointerFile(dir)) {
      try {
        const project = resolveProject(dir, env)
        found = {
          kind: 'tracked',
          project,
          config: loadConfig(configDirs(project.storeDir, env)),
        }
      } catch (e) {
        log(`hafiz: project pointer found but unusable, staying inactive: ${String(e)}`)
      }
    } else {
      const worktree = worktreeOf(dir)
      if (worktree)
        found = { kind: 'untracked', worktree, config: loadConfig([userConfigDir(env)]) }
    }
  } catch (e) {
    log(`hafiz: config unreadable, staying inactive: ${String(e)}`)
    found = null
  }
  if (cache) detection.set(dir, found)
  return found
}

/** The node binary for child processes. Inside Kilo the plugin runs under Bun's kilo binary. */
function nodeBinary(env: NodeJS.ProcessEnv): string {
  return env.HAFIZ_NODE || (process.versions.bun ? 'node' : process.execPath)
}

/**
 * argv prefix for the hafiz CLI: $HAFIZ_BIN, else the `hafiz` package's bin (published layout),
 * else @hafiz/cli's bin.js (workspace layout), else `hafiz` on PATH.
 */
function hafizCommand(env: NodeJS.ProcessEnv): string[] {
  const node = nodeBinary(env)
  if (env.HAFIZ_BIN) return [node, env.HAFIZ_BIN]
  // Both packages export only an `import` condition, so resolve as ESM (works in Node and Bun).
  const candidates: Array<() => string> = [
    () => fileURLToPath(import.meta.resolve('hafiz/bin')),
    () => join(dirname(fileURLToPath(import.meta.resolve('@hafiz/cli'))), 'bin.js'),
  ]
  for (const candidate of candidates)
    try {
      const bin = candidate()
      if (existsSync(bin)) return [node, bin]
    } catch {}
  return ['hafiz']
}

const TASK_RESULT =
  /<task id="([^"]+)" state="completed">\n(?:<summary>[\s\S]*?<\/summary>\n)?<task_result>\n?([\s\S]*?)\n?<\/task_result>/

/** Final non-synthetic assistant text of a message list (what Kilo's task tool returns). */
export function finalAssistantText(messages: KiloMessageWithParts[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as KiloMessageWithParts
    if (m.info.role !== 'assistant') continue
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j]
      if (p?.type === 'text' && !p.synthetic && !p.ignored && p.text) return p.text
    }
  }
  return undefined
}

interface PluginCtx {
  input: PluginInput
  options: PluginOptions
  deps: HafizPluginDeps
  env: NodeJS.ProcessEnv
  log: (line: string) => void
  hafiz: string[]
}

interface Managed {
  hooks: Hooks
  sessions: SessionRegistry
  project: ResolvedProject
}

/** Environment the MCP servers / daemon need from ours. */
function passEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    ['HAFIZ_STORE_ROOT', 'XDG_RUNTIME_DIR', 'HAFIZ_BIN']
      .filter((k) => env[k])
      .map((k) => [k, env[k] as string]),
  )
}

const toolsModeOf = (options: PluginOptions, config: Config) =>
  ((options as { tools?: unknown }).tools ?? config.hafiz.host.kilo.tools) as 'native' | 'mcp'

export function createHafizPlugin(deps: HafizPluginDeps = {}): Plugin {
  return async (input: PluginInput, options = {}): Promise<Hooks> => {
    const env = deps.env ?? process.env
    const log = deps.log ?? ((l: string) => console.error(l))
    const found = detect(input.directory, env, log, !deps.noCache)
    // Outside git there is nothing to track: no hooks at all.
    if (!found) return {}
    const ctx: PluginCtx = {
      input,
      options,
      deps,
      env,
      log,
      hafiz: deps.hafiz ?? hafizCommand(env),
    }
    if (found.kind === 'untracked') return untrackedHooks(ctx, found.worktree, found.config)
    return managedHooks(ctx, found.project, found.config).hooks
  }
}

/**
 * The managed plugin for a tracked project. `late`: built mid-session by hafiz_track_project,
 * after Kilo ran the `config` hook and read the tool list. The untracked hooks already installed
 * the agents and permissions and registered the tools; this instance shapes through the
 * transform hooks only (the embedded proxy needs provider URLs re-pointed at startup).
 */
function managedHooks(
  ctx: PluginCtx,
  project: ResolvedProject,
  config: Config,
  opts: { late?: boolean } = {},
): Managed {
  const { input, options, deps, env, log, hafiz } = ctx
  const configured = ((options as { shaper?: unknown }).shaper ??
    config.hafiz.host.kilo.shaper) as ShaperSetting
  if (opts.late && configured === 'proxy')
    log('hafiz: shaper proxy needs a Kilo restart; shaping through hooks until then')
  const setting: ShaperSetting = opts.late ? 'hooks' : configured
  const connect =
    deps.connect ??
    ((p: ResolvedProject) =>
      ensureDaemon(p, {
        env,
        spawnDaemon: (pr) => {
          const [cmd, ...args] = hafiz
          spawn(cmd as string, [...args, 'daemon', '--project', pr.worktree], {
            detached: true,
            stdio: 'ignore',
            env,
          })
            .on('error', (e) => log(`hafiz: cannot start the daemon (${cmd}): ${e.message}`))
            .unref()
        },
      }))
  // `llm.*.provider: kilo`: the daemon relays condenser/drafter calls to this plugin, which runs
  // them as child sessions of the session they work for (llm.ts).
  const kiloLlm = usesKiloLlm(config.hafiz.llm)
  const condenserSystems = new Map<string, string>()
  const sessions: SessionRegistry = new SessionRegistry({
    project,
    config,
    connect: () => connect(project),
    log,
    ...(kiloLlm
      ? {
          llm: {
            providers: ['kilo'],
            handler: kiloRelayHandler({
              client: input.client,
              directory: input.directory,
              ignore: (id) => sessions.ignore(id),
              systems: condenserSystems,
            }),
          },
        }
      : {}),
  })
  const shaper = new ConversationShaper({ config, source: sessions, log })
  const useHooks = setting !== 'proxy'
  const useProxy = setting !== 'hooks'
  const hooks = useHooks ? new TransformHooksShaper(shaper, log) : undefined
  const proxy = useProxy
    ? new EmbeddedProxy({
        shaper,
        log,
        onUsage: (sid, u) =>
          void sessions.counters(sid, {
            wire_requests: 1,
            wire_input: u.input,
            wire_output: u.output,
            wire_cache_read: u.cacheRead,
            wire_cache_write: u.cacheWrite,
          }),
      })
    : undefined
  const fallbackMs = deps.reportFallbackMs ?? 1500

  const childReport = async (childId: string) => {
    const k = sessions.get(childId)
    if (!k?.parentId || !sessions.isManaged(childId) || !input.client?.session?.messages) return
    const r = await input.client.session.messages({
      path: { id: childId },
      query: { directory: input.directory },
    })
    const text = r?.data ? finalAssistantText(r.data) : undefined
    if (text) await sessions.captureReport(childId, text)
  }

  const toolsMode = toolsModeOf(options, config)

  const out: Hooks = {
    async config(cfg) {
      const proxyBase = proxy ? await proxy.start() : undefined
      installConfig(cfg, {
        config,
        worktree: project.worktree,
        storeDir: project.storeDir,
        hafiz,
        tools: toolsMode,
        env: passEnv(env),
        ...(proxy && proxyBase ? { wrap: (id: string, url: string) => proxy.wrap(id, url) } : {}),
      })
      if (kiloLlm) {
        const llm = config.hafiz.llm
        installCondenserAgent(
          cfg,
          llm.condenser.provider === 'kilo' ? llm.condenser.model : llm.drafters.model,
        )
      }
    },

    async event({ event }: { event: KiloEvent }) {
      const p = event.properties ?? {}
      const sid = typeof p.sessionID === 'string' ? p.sessionID : undefined
      switch (event.type) {
        case 'session.created': {
          const info = p.info as { id: string; parentID?: string; agent?: string } | undefined
          if (info?.id) sessions.noteSession(info)
          return
        }
        case 'session.idle':
          // Background tasks never reach tool.execute.after with a result; read it here.
          if (sid && sessions.get(sid)?.parentId && sessions.isManaged(sid))
            setTimeout(() => void childReport(sid).catch(() => undefined), fallbackMs).unref?.()
          return
        case 'session.deleted': {
          const id = sid ?? (p.info as { id?: string } | undefined)?.id
          if (id) {
            await sessions.end(id)
            shaper.forget(id)
          }
          return
        }
        case 'message.updated': {
          const info = p.info as KiloMessageWithParts['info'] | undefined
          if (info?.role !== 'assistant' || !info.time?.completed || !info.tokens) return
          if (!sessions.isManaged(info.sessionID) || counted.has(info.id)) return
          counted.add(info.id)
          const t = info.tokens
          await sessions.counters(info.sessionID, {
            tokens_in: t.input,
            tokens_out: t.output,
            cache_read: t.cache?.read ?? 0,
            cache_write: t.cache?.write ?? 0,
          })
          return
        }
      }
    },

    async 'chat.message'(i, o) {
      const agent = i.agent ?? o.message.agent
      const prompt = o.parts
        .filter((x) => x.type === 'text' && typeof x.text === 'string')
        .map((x) => x.text)
        .join('\n')
      if (await sessions.open(i.sessionID, { agent, prompt }))
        await sessions.counters(i.sessionID, USER_TURN_COUNTERS)
    },

    async 'tool.execute.after'(i, o) {
      if (!sessions.isManaged(i.sessionID)) return
      await sessions.counters(i.sessionID, toolCounters(i.tool))
      if (i.tool !== 'task') return
      const m = TASK_RESULT.exec(o.output)
      if (!m) return
      const child = m[1] as string
      if (await sessions.open(child)) {
        await sessions.captureReport(child, m[2] as string)
        await sessions.end(child)
      }
    },
  }
  const counted = new Set<string>()
  if (toolsMode === 'native') out.tool = nativeTools({ config, sessions })

  if (proxy)
    out['chat.headers'] = async (i, o) => {
      // Hooks already shaped this request (or the agent is not managed): stay out.
      if (hooks?.seen.has(i.sessionID)) return
      // Only the session's own agent: title/summary calls share the session id.
      const k = sessions.get(i.sessionID)
      if (k?.agent === i.agent && sessions.isManaged(i.sessionID))
        o.headers[SESSION_HEADER] = i.sessionID
    }
  if (kiloLlm) out['experimental.chat.system.transform'] = condenserSystemHook(condenserSystems)
  if (hooks) {
    const shape = out['experimental.chat.system.transform']
    out['experimental.chat.system.transform'] = async (i, o) => {
      await shape?.(i, o)
      if (!i.sessionID || !sessions.isManaged(i.sessionID)) return
      const r = await hooks.shape({
        sessionId: i.sessionID,
        model: i.model?.id,
        system: o.system,
      })
      if (r.system && r.system !== o.system) o.system.splice(0, o.system.length, ...r.system)
    }
    out['experimental.chat.messages.transform'] = async (_i, o) => {
      const sid = o.messages[0]?.info.sessionID
      if (!sid || !sessions.isManaged(sid)) return
      const r = await hooks.shape({ sessionId: sid, messages: o.messages })
      if (r.messages && r.messages !== o.messages)
        o.messages.splice(0, o.messages.length, ...r.messages)
    }
  }
  out.dispose = async () => {
    await proxy?.close()
    await sessions.close()
  }
  return { hooks: out, sessions, project }
}

/**
 * Hide `hidden` and un-hide `shown` for this request. Kilo drops a tool from the request when the
 * turn's user message says `tools[name] === false`, and it reads that from the message objects
 * this hook receives (after resolving tools, before building the request), re-read from its
 * database every step. So the change is per request and never persisted.
 */
export function setToolVisibility(
  messages: KiloMessageWithParts[],
  hidden: readonly string[],
  shown: readonly string[],
): void {
  for (const m of messages) {
    if (m.info.role !== 'user') continue
    const info = m.info as { tools?: Record<string, boolean> }
    info.tools ??= {}
    const tools = info.tools
    for (const n of hidden) tools[n] = false
    for (const n of shown) if (tools[n] === false) delete tools[n]
  }
}

/**
 * An untracked git repo. Costs nothing per request beyond the track tool's definition (~90
 * tokens) and, once, the nudge line. Kilo reads agents, permissions and the tool list once at
 * startup, so everything managed mode needs is put in place now (the config hook installs the
 * role agents and permissions; the Hafiz tools are registered) and kept invisible: every request
 * hides the Hafiz tools but `hafiz_track_project`. Calling that tool initialises the project and
 * builds the managed hooks; from the next request on every hook delegates to them and the tools
 * are shown instead.
 */
function untrackedHooks(ctx: PluginCtx, worktree: string, config: Config): Hooks {
  const { input, options, env, log, hafiz } = ctx
  const mode = toolsModeOf(options, config)
  const nudge = createNudgeHooks(config)
  let managed: Managed | undefined
  let tracking:
    | Promise<{ id: string; name: string; rootBlockId: string; onboarding: boolean }>
    | undefined
  // session.created before tracking: replayed so parents and agents are known afterwards
  const noted = new Map<string, { id: string; parentID?: string; agent?: string }>()

  const hafizTools =
    mode === 'native' ? nativeTools({ config, sessions: () => managed?.sessions }) : {}
  const hafizNames = Object.keys(hafizTools)

  const roleOf = (agent: string | undefined): string => {
    if (agent && agentRoleNames(config).includes(agent)) return agent
    const r = config.hafiz.host.kilo.default_role
    return r && r !== 'none' ? r : 'user'
  }

  const track = trackTool(async (args, tctx) => {
    if (noted.get(tctx.sessionID)?.parentID)
      throw new HafizToolError(
        `${TRACK_TOOL} is for the primary agent; a subagent cannot start tracking.`,
      )
    const already = !!tracking
    tracking ??= (async () => {
      const by: Actor = {
        sessionId: tctx.sessionID,
        role: roleOf(tctx.agent),
        ...(tctx.agent ? { agent: tctx.agent } : {}),
      }
      const r = await initProject({ cwd: input.directory, name: args.name, env, by })
      const project = resolveProject(input.directory, env)
      const storeConfig = loadConfig(configDirs(project.storeDir, env))
      detection.set(input.directory, { kind: 'tracked', project, config: storeConfig })
      const m = managedHooks(ctx, project, storeConfig, { late: true })
      for (const info of noted.values()) m.sessions.noteSession(info)
      managed = m
      return { id: r.id, name: r.name, rootBlockId: r.rootBlockId, onboarding: r.onboarding }
    })()
    let r: Awaited<typeof tracking>
    try {
      r = await tracking
    } catch (e) {
      tracking = undefined
      throw new HafizToolError(`${TRACK_TOOL}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (already)
      return {
        title: TRACK_TOOL,
        output: `Already tracking this repo with Hafiz as \`${r.name}\`.`,
      }
    const m = managed as Managed
    // Open the caller now: the daemon starts, and its next request is managed.
    const opened = await m.sessions.open(tctx.sessionID, { agent: tctx.agent })
    if (opened && args.reason)
      await m.sessions
        .call(tctx.sessionID, 'dispatch', {
          command: 'decision.record',
          args: { block: r.rootBlockId, title: 'Tracking with Hafiz', decision: args.reason },
        })
        .catch((e) => log(`hafiz: could not record the tracking reason: ${String(e)}`))
    const tail = r.onboarding ? ' Existing code: onboarding is pending (see your view).' : ''
    return {
      title: TRACK_TOOL,
      output: `Hafiz now tracks this repo as \`${r.name}\` (${r.id}); your Hafiz tools, rules and project view apply from your next step.${tail}`,
      metadata: { hafiz_project: r.id },
    }
  })

  const out: Hooks = {
    tool: { [TRACK_TOOL]: track, ...hafizTools },

    async config(cfg) {
      installConfig(cfg, {
        config,
        worktree,
        // no store yet: keep agents out of every store
        storeDir: defaultStoreRoot(env),
        hafiz,
        tools: mode,
        env: passEnv(env),
        untracked: { trackTool: TRACK_TOOL },
      })
      if (usesKiloLlm(config.hafiz.llm)) {
        const llm = config.hafiz.llm
        installCondenserAgent(
          cfg,
          llm.condenser.provider === 'kilo' ? llm.condenser.model : llm.drafters.model,
        )
      }
    },

    async event(e) {
      if (managed) return managed.hooks.event?.(e)
      if (e.event.type === 'session.created') {
        const info = e.event.properties?.info as
          | { id: string; parentID?: string; agent?: string }
          | undefined
        if (info?.id) noted.set(info.id, info)
      } else if (e.event.type === 'session.deleted') {
        const p = e.event.properties ?? {}
        const id = (p.sessionID ?? (p.info as { id?: string } | undefined)?.id) as
          | string
          | undefined
        if (id) noted.delete(id)
      }
      return nudge.event?.(e)
    },
    async 'chat.message'(i, o) {
      return (managed?.hooks ?? nudge)['chat.message']?.(i, o)
    },
    async 'tool.execute.after'(i, o) {
      return (managed?.hooks ?? nudge)['tool.execute.after']?.(i, o)
    },
    async 'experimental.chat.system.transform'(i, o) {
      return (managed?.hooks ?? nudge)['experimental.chat.system.transform']?.(i, o)
    },
    async 'experimental.chat.messages.transform'(i, o) {
      // on Kilo's own message objects, before the shaper may replace them with copies
      if (managed) setToolVisibility(o.messages, [TRACK_TOOL], hafizNames)
      else setToolVisibility(o.messages, hafizNames, [TRACK_TOOL])
      return managed?.hooks['experimental.chat.messages.transform']?.(i, o)
    },
    async dispose() {
      await managed?.hooks.dispose?.()
    },
  }
  return out
}

/** Test seam: forget cached project detection. */
export function resetDetectionCache(): void {
  detection.clear()
}
