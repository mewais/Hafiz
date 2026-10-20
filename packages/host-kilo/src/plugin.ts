// The Kilo plugin. In a repo without `.hafiz/project.yaml` it returns no hooks at all (zero cost;
// the decision is cached per directory). Otherwise it installs config, registers the Hafiz tools
// (plugin-native, resolved per calling session), observes sessions, captures subagent reports and
// shapes requests through the selected RequestShaper.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Config,
  findPointerFile,
  loadConfig,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import { type DaemonClient, ensureDaemon } from '@hafiz/gateway-mcp'
import { toolCounters, USER_TURN_COUNTERS } from './counters.js'
import { installConfig } from './install.js'
import type { Hooks, KiloEvent, KiloMessageWithParts, Plugin, PluginInput } from './kilo.js'
import { createNudgeHooks } from './nudge.js'
import { SessionRegistry } from './sessions.js'
import { ConversationShaper } from './shaper/core.js'
import { TransformHooksShaper } from './shaper/hooks.js'
import { EmbeddedProxy, SESSION_HEADER } from './shaper/proxy.js'
import type { ShaperSetting } from './shaper/types.js'
import { nativeTools } from './tools.js'

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

interface Detected {
  project: ResolvedProject
  config: Config
}

const detection = new Map<string, Detected | null>()

function detect(dir: string, env: NodeJS.ProcessEnv, log: (l: string) => void, cache: boolean) {
  if (cache && detection.has(dir)) return detection.get(dir) ?? null
  let found: Detected | null = null
  if (findPointerFile(dir)) {
    try {
      found = { project: resolveProject(dir, env), config: loadConfig() }
    } catch (e) {
      log(`hafiz: project pointer found but unusable, staying inactive: ${String(e)}`)
    }
  }
  if (cache) detection.set(dir, found)
  return found
}

/** The node binary for child processes. Inside Kilo the plugin runs under Bun's kilo binary. */
function nodeBinary(env: NodeJS.ProcessEnv): string {
  return env.HAFIZ_NODE || (process.versions.bun ? 'node' : process.execPath)
}

/** argv prefix for the hafiz CLI: $HAFIZ_BIN, else @hafiz/cli's bin.js next to this package. */
function hafizCommand(env: NodeJS.ProcessEnv): string[] {
  const node = nodeBinary(env)
  if (env.HAFIZ_BIN) return [node, env.HAFIZ_BIN]
  try {
    // @hafiz/cli exports only an `import` condition, so resolve as ESM (works in Node and Bun).
    const bin = join(dirname(fileURLToPath(import.meta.resolve('@hafiz/cli'))), 'bin.js')
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

export function createHafizPlugin(deps: HafizPluginDeps = {}): Plugin {
  return async (input: PluginInput, options = {}): Promise<Hooks> => {
    const env = deps.env ?? process.env
    const log = deps.log ?? ((l: string) => console.error(l))
    const found = detect(input.directory, env, log, !deps.noCache)
    // No Hafiz project: in-memory nudge only. No daemon, no config changes, no proxy.
    if (!found) {
      try {
        return createNudgeHooks(loadConfig())
      } catch (e) {
        log(`hafiz: config unreadable, nudge disabled: ${String(e)}`)
        return {}
      }
    }
    const { project, config } = found
    const hafiz = deps.hafiz ?? hafizCommand(env)

    const setting = ((options as { shaper?: unknown }).shaper ??
      config.hafiz.host.kilo.shaper) as ShaperSetting
    const connect =
      deps.connect ??
      ((p: ResolvedProject) =>
        ensureDaemon(p, {
          env,
          spawnDaemon: (pr) => {
            const [cmd, ...args] = hafiz
            spawn(cmd as string, [...args, 'daemon', '--project', pr.repoRoot], {
              detached: true,
              stdio: 'ignore',
              env,
            })
              .on('error', (e) => log(`hafiz: cannot start the daemon (${cmd}): ${e.message}`))
              .unref()
          },
        }))
    const sessions = new SessionRegistry({ project, config, connect: () => connect(project), log })
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

    const toolsMode = ((options as { tools?: unknown }).tools ?? config.hafiz.host.kilo.tools) as
      | 'native'
      | 'mcp'

    const out: Hooks = {
      async config(cfg) {
        const proxyBase = proxy ? await proxy.start() : undefined
        installConfig(cfg, {
          config,
          repoRoot: project.repoRoot,
          storeDir: project.storeDir,
          hafiz,
          tools: toolsMode,
          env: Object.fromEntries(
            ['HAFIZ_STORE_ROOT', 'XDG_RUNTIME_DIR', 'HAFIZ_BIN']
              .filter((k) => env[k])
              .map((k) => [k, env[k] as string]),
          ),
          ...(proxy && proxyBase ? { wrap: (id: string, url: string) => proxy.wrap(id, url) } : {}),
        })
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
    if (hooks) {
      out['experimental.chat.system.transform'] = async (i, o) => {
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
    return out
  }
}

/** Test seam: forget cached project detection. */
export function resetDetectionCache(): void {
  detection.clear()
}
