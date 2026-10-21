// Plugin-native Hafiz tools: one catalogue shared with the MCP gateway, per-call resolution of the
// calling Kilo session, default roles for non-Hafiz agents, and the generated permission config.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import { type Config, loadConfig, toolName, toolsForRole } from '@hafiz/core'
import { createMcpServer, DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  agentRoles,
  createHafizPlugin,
  type Hooks,
  installConfig,
  type KiloConfig,
  type KiloToolContext,
  managedRoles,
  SessionRegistry,
  toolNamesForRole,
} from '../src/index.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const ev = (type: string, properties: Record<string, unknown>) => ({ event: { type, properties } })
const text = (t: string) => [{ type: 'text', text: t }]
const ctx = (sessionID: string, agent: string): KiloToolContext => ({
  sessionID,
  agent,
  messageID: 'msg_1',
})

async function live() {
  const cwd = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  expect(await run(['init', 'Shop'], io)).toBe(0)
  const d: DaemonHandle = await startDaemon({ projectDir: cwd, env, idleShutdownMs: 0 })
  cleanup.push(() => d.close())
  const user = await DaemonClient.connect(d.socketPath)
  cleanup.push(() => user.close())
  await user.openSession({ id: 'cli', host: 'test', role: 'user' })
  const root = (await user.treeList())[0]?.id as string
  const blocks: string[] = []
  for (const title of ['Payments', 'Shipping']) {
    const { result } = await user.dispatch<{ id: string }>('block.create', { parent: root, title })
    await user.dispatch('block.set_status', { id: result.id, status: 'active' })
    blocks.push(result.id)
  }
  const hooks = await createHafizPlugin({
    env,
    hafiz: ['node', '/opt/hafiz/bin.js'],
    noCache: true,
    log: (l) => {
      if (process.env.DEBUG_HAFIZ) console.error(l)
    },
    connect: () => DaemonClient.connect(d.socketPath),
  })({ directory: cwd, worktree: cwd }, {})
  cleanup.push(() => hooks.dispose?.())
  // Always read the live state: a captured `read` is a snapshot.
  const read = () => d.service.core.backend.read
  return { hooks, read, root, blocks: blocks as [string, string] }
}

/** Kilo's sequence for a new session: session.created, then the first chat.message. */
async function session(hooks: Hooks, id: string, agent: string, prompt: string, parentID?: string) {
  await hooks.event?.(
    ev('session.created', {
      sessionID: id,
      info: { id, agent, ...(parentID ? { parentID } : {}) },
    }),
  )
  await hooks['chat.message']?.(
    { sessionID: id, agent },
    { message: { agent }, parts: text(prompt) },
  )
}

function tool(hooks: Hooks, name: string) {
  const t = hooks.tool?.[name]
  if (!t) throw new Error(`no native tool ${name}`)
  return t
}

describe('shared tool catalogue', () => {
  it('the MCP gateway and the Kilo native tools expose the same tools per role', () => {
    const config = loadConfig()
    for (const role of agentRoles(config)) {
      const mcp = createMcpServer({ role, client: {} as DaemonClient, config }).tools
      expect(toolNamesForRole(config, role)).toEqual(mcp)
    }
  })

  it('registers each catalogue tool any managed role can use, with the catalogue description', async () => {
    const { hooks } = await live()
    const config = loadConfig()
    const union = new Set(
      managedRoles(config).flatMap((r) => toolsForRole(config, r).map((t) => t.spec)),
    )
    expect(Object.keys(hooks.tool ?? {}).sort()).toEqual(
      [...union].map((s) => toolName(s.command)).sort(),
    )
    const spec = [...union].find((s) => s.command === 'progress.append')
    expect(tool(hooks, 'hafiz_progress_append').description).toBe(spec?.description(config))
  })
})

describe('native tools resolve the calling Kilo session', () => {
  it('attributes a worker call to its own session, role and spawned block', async () => {
    const { hooks, read, blocks } = await live()
    await session(hooks, 'ses_m', 'manager', 'Ship it')
    await session(hooks, 'ses_w', 'worker', `hafiz:block=${blocks[0]} fix rounding`, 'ses_m')
    const out = await tool(hooks, 'hafiz_progress_append').execute(
      { block: blocks[0], kind: 'found', text: 'Rounding happens twice.' },
      ctx('ses_w', 'worker'),
    )
    expect(typeof out === 'string' ? out : out.output).toContain('"kind":"found"')
    const w = await read().getSession('ses_w')
    expect(w).toMatchObject({ role: 'worker', parentSessionId: 'ses_m', host: 'kilo' })
    expect(w?.focus.blocks).toEqual([blocks[0]])
    const audit = (await read().readAudit()).filter((a) => a.command === 'progress.append:found')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.by).toMatchObject({ sessionId: 'ses_w', role: 'worker', agent: 'worker' })
    const log = await read().readLog(blocks[0], 'progress')
    expect((log[0]?.entry as { by?: { sessionId: string } } | undefined)?.by?.sessionId).toBe(
      'ses_w',
    )
  })

  it('keeps two concurrent workers on different blocks apart', async () => {
    const { hooks, read, blocks } = await live()
    await session(hooks, 'ses_m', 'manager', 'Ship both')
    await Promise.all([
      session(hooks, 'ses_w1', 'worker', `hafiz:block=${blocks[0]} payments`, 'ses_m'),
      session(hooks, 'ses_w2', 'worker', `hafiz:block=${blocks[1]} shipping`, 'ses_m'),
    ])
    const ctxFor = tool(hooks, 'hafiz_context_for')
    const append = tool(hooks, 'hafiz_progress_append')
    const [v1, v2] = await Promise.all([
      ctxFor.execute({}, ctx('ses_w1', 'worker')),
      ctxFor.execute({}, ctx('ses_w2', 'worker')),
      append.execute({ block: blocks[0], kind: 'found', text: 'one' }, ctx('ses_w1', 'worker')),
      append.execute({ block: blocks[1], kind: 'found', text: 'two' }, ctx('ses_w2', 'worker')),
    ])
    const s1 = await read().getSession('ses_w1')
    const s2 = await read().getSession('ses_w2')
    expect(s1?.token).not.toBe(s2?.token)
    expect(s1?.focus.blocks).toEqual([blocks[0]])
    expect(s2?.focus.blocks).toEqual([blocks[1]])
    const focusLine = (v: unknown) =>
      String(typeof v === 'string' ? v : (v as { output: string }).output)
        .split('\n')
        .find((l) => l.includes('focus'))
    expect(focusLine(v1)).toContain('Payments')
    expect(focusLine(v2)).toContain('Shipping')
    const by = async (b: string) =>
      (await read().readLog(b, 'progress')).map(
        (e) => (e.entry as { by: { sessionId: string } }).by.sessionId,
      )
    expect(await by(blocks[0])).toEqual(['ses_w1'])
    expect(await by(blocks[1])).toEqual(['ses_w2'])
  })

  it('refuses a tool outside the caller’s role before it reaches the daemon', async () => {
    const { hooks, root, blocks } = await live()
    await session(hooks, 'ses_m', 'manager', 'go')
    await session(hooks, 'ses_w', 'worker', `hafiz:block=${blocks[0]}`, 'ses_m')
    await expect(
      tool(hooks, 'hafiz_block_create').execute(
        { parent: root, title: 'Nope' },
        ctx('ses_w', 'worker'),
      ),
    ).rejects.toThrow(/not available to the worker role/)
  })

  it('a planner cannot call hafiz_progress_append; a designer only with kind found or question', async () => {
    const { hooks, blocks } = await live()
    await session(hooks, 'ses_m', 'manager', 'go')
    await session(hooks, 'ses_planner', 'planner', `hafiz:block=${blocks[0]}`, 'ses_m')
    await expect(
      tool(hooks, 'hafiz_progress_append').execute(
        { block: blocks[0], kind: 'found', text: 'x' },
        ctx('ses_planner', 'planner'),
      ),
    ).rejects.toThrow(/not available to the/)
    await session(hooks, 'ses_designer', 'designer', `hafiz:block=${blocks[0]}`, 'ses_m')
    const append = tool(hooks, 'hafiz_progress_append')
    await expect(
      append.execute(
        { block: blocks[0], kind: 'done', text: 'x' },
        ctx('ses_designer', 'designer'),
      ),
    ).rejects.toThrow()
    await append.execute(
      { block: blocks[0], kind: 'found', text: 'x' },
      ctx('ses_designer', 'designer'),
    )
  })

  it('system.progress is in no role’s tool list and is not a dispatchable command', async () => {
    const { hooks } = await live()
    const config = loadConfig()
    for (const role of agentRoles(config)) {
      expect(toolNamesForRole(config, role).join(' ')).not.toMatch(/report/)
      expect(toolsForRole(config, role).map((t) => t.spec.command)).not.toContain('system.progress')
    }
    expect(Object.keys(hooks.tool ?? {}).join(' ')).not.toMatch(/report_capture/)
  })

  it('daemon errors come back as tool errors the agent can act on', async () => {
    const { hooks } = await live()
    await session(hooks, 'ses_m', 'manager', 'go')
    await expect(
      tool(hooks, 'hafiz_block_read').execute({ id: 'blk_missing' }, ctx('ses_m', 'manager')),
    ).rejects.toThrow(/blk_missing/)
  })
})

describe('default roles for non-Hafiz agents', () => {
  it('manages Kilo’s build agent as the manager: session, tools and rules + view', async () => {
    const { hooks, read, root } = await live()
    await session(hooks, 'ses_b', 'build', 'Add a refunds feature')
    expect(await read().getSession('ses_b')).toMatchObject({ role: 'manager', agent: 'build' })
    await tool(hooks, 'hafiz_block_create').execute(
      { parent: root, title: 'Refunds' },
      ctx('ses_b', 'build'),
    )
    expect((await read().listBlocks()).map((b) => b.title)).toContain('Refunds')
    const system = ['You are Kilo.']
    await hooks['experimental.chat.system.transform']?.(
      { sessionID: 'ses_b', model: { id: 'm', providerID: 'p' } },
      { system },
    )
    expect(system).toHaveLength(2)
    // build runs Kilo's prompt, so the manager rules travel with the envelope
    expect(system[1]).toMatch(/^# Hafiz rules — manager/)
    expect(system[1]).toMatch(/<hafiz hash="[0-9a-f]{12}" role="manager">/)
  })

  it('leaves a non-Hafiz subagent without a block marker unmanaged', async () => {
    const { hooks, read } = await live()
    await session(hooks, 'ses_b', 'build', 'look around')
    await session(hooks, 'ses_x', 'explore', 'Find where rounding happens', 'ses_b')
    expect(await read().getSession('ses_x')).toBeNull()
    await expect(
      tool(hooks, 'hafiz_context_for').execute({}, ctx('ses_x', 'explore')),
    ).rejects.toThrow(/not managed by Hafiz/)
    const system = ['You are explore.']
    await hooks['experimental.chat.system.transform']?.(
      { sessionID: 'ses_x', model: { id: 'm', providerID: 'p' } },
      { system },
    )
    expect(system).toEqual(['You are explore.'])
  })

  it('manages a non-Hafiz subagent spawned on a block as the default subagent role', async () => {
    const { hooks, read, blocks } = await live()
    await session(hooks, 'ses_b', 'build', 'go')
    await session(hooks, 'ses_g', 'general', `hafiz:block=${blocks[1]} do it`, 'ses_b')
    expect(await read().getSession('ses_g')).toMatchObject({
      role: 'worker',
      parentSessionId: 'ses_b',
    })
    expect((await read().getSession('ses_g'))?.focus.blocks).toEqual([blocks[1]])
  })

  it('default_role: none leaves primary agents unmanaged', () => {
    const base = loadConfig()
    const config: Config = {
      ...base,
      hafiz: {
        ...base.hafiz,
        host: { kilo: { ...base.hafiz.host.kilo, default_role: 'none' } },
      },
    }
    const reg = new SessionRegistry({
      project: {} as never,
      config,
      connect: () => Promise.reject(new Error('unused')),
      log: () => undefined,
    })
    expect(reg.roleFor('build')).toBeUndefined()
    expect(reg.roleFor('manager')).toBe('manager')
    expect(reg.roleFor('explore', { subagent: true })).toBeUndefined()
    expect(reg.roleFor('explore', { subagent: true, block: 'blk_1' })).toBe('worker')
  })
})

// ───────────────────── generated permission config ─────────────────────

type Rule = { permission: string; pattern: string; action: string }

/** Kilo's config → ruleset conversion (object key order) for tool-level permissions. */
function rules(perm: unknown): Rule[] {
  if (typeof perm === 'string') return [{ permission: '*', pattern: '*', action: perm }]
  return Object.entries((perm ?? {}) as Record<string, unknown>).flatMap(([k, v]) =>
    typeof v === 'string'
      ? [{ permission: k, pattern: '*', action: v }]
      : Object.entries(v as Record<string, string>).map(([pattern, action]) => ({
          permission: k,
          pattern,
          action,
        })),
  )
}

const glob = (g: string) =>
  new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)

/** Last match wins (Kilo's evaluate). */
function action(tool: string, set: Rule[]): string {
  return set.findLast((r) => glob(r.permission).test(tool) && r.pattern === '*')?.action ?? 'ask'
}

/** What Kilo copies from the calling agent into a spawned subagent's session (verified, §3.3). */
function inherited(caller: Rule[], mcp: Record<string, unknown>): Rule[] {
  const prefixes = Object.keys(mcp).map((n) => `${n.replace(/[^a-zA-Z0-9_-]/g, '_')}_`)
  return caller.filter(
    (r) => r.action === 'deny' && prefixes.some((p) => r.permission.startsWith(p)),
  )
}

describe('generated permission config', () => {
  const config = loadConfig()
  const cfg: KiloConfig = {
    permission: { '*': 'allow', bash: 'ask' },
    agent: { reviewer: { mode: 'subagent', prompt: 'review' } },
  }
  installConfig(cfg, { config, worktree: '/r', storeDir: '/s', hafiz: ['hafiz'] })
  const all = TOOLS()
  function TOOLS() {
    return [...new Set(agentRoles(config).flatMap((r) => toolNamesForRole(config, r)))]
  }
  const agentRules = (name: string) => [
    ...rules(cfg.permission),
    ...rules(cfg.agent?.[name]?.permission),
  ]
  const visible = (set: Rule[]) => all.filter((t) => action(t, set) !== 'deny').sort()
  const roleSet = (role: string) => [...toolNamesForRole(config, role)].sort()

  it('gives each role agent exactly its own tools', () => {
    for (const role of agentRoles(config)) expect(visible(agentRules(role))).toEqual(roleSet(role))
  })

  it('a subagent spawned by any agent keeps its own role’s set', () => {
    for (const parent of ['manager', 'build', 'planner'])
      for (const child of ['designer', 'planner', 'worker']) {
        const set = [...agentRules(child), ...inherited(agentRules(parent), cfg.mcp ?? {})]
        expect(visible(set), `${parent} -> ${child}`).toEqual(roleSet(child))
      }
  })

  it('primary non-Hafiz agents get the default role, subagents the default subagent role', () => {
    for (const a of ['build', 'plan', 'my-custom-primary'])
      expect(visible(agentRules(a)), a).toEqual(roleSet('manager'))
    for (const a of ['general', 'explore', 'reviewer'])
      expect(visible(agentRules(a)), a).toEqual(roleSet('worker'))
  })

  it('a user `*: allow` cannot re-open what Hafiz denies; store stays denied', () => {
    const keys = Object.keys(cfg.permission as object)
    expect(keys.indexOf('*')).toBeLessThan(keys.indexOf('hafiz_*'))
    expect((cfg.permission as Record<string, Record<string, string>>).read?.['/s/**']).toBe('deny')
  })
})
