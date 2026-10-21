import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import { loadConfig, rulesFor } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  capReport,
  createHafizPlugin,
  type Hooks,
  installConfig,
  type KiloConfig,
  type KiloMessageWithParts,
  type PluginInput,
  RULES_SEPARATOR,
  SESSION_HEADER,
} from '../src/index.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const HAFIZ = ['node', '/opt/hafiz/bin.js']

async function repo(init: boolean) {
  const cwd = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  if (init) expect(await run(['init', 'Shop'], io)).toBe(0)
  return { cwd, env }
}

async function plugin(
  r: { cwd: string; env: NodeJS.ProcessEnv },
  options: Record<string, unknown> = {},
  extra: Parameters<typeof createHafizPlugin>[0] = {},
  client?: PluginInput['client'],
): Promise<Hooks> {
  const logs: string[] = []
  const hooks = await createHafizPlugin({
    env: r.env,
    hafiz: HAFIZ,
    noCache: true,
    log: (l) => {
      logs.push(l)
      if (process.env.DEBUG_HAFIZ) console.error(l)
    },
    reportFallbackMs: 10,
    ...extra,
  })({ directory: r.cwd, worktree: r.cwd, ...(client ? { client } : {}) }, options)
  cleanup.push(() => hooks.dispose?.())
  return hooks
}

/** Replace machine-specific paths so the snapshot is stable. */
function normalise(v: unknown, r: { cwd: string; env: NodeJS.ProcessEnv }): unknown {
  let s = JSON.stringify(v)
  for (const [from, to] of [
    [r.env.HAFIZ_STORE_ROOT as string, '<STORE_ROOT>'],
    [r.env.XDG_RUNTIME_DIR as string, '<RUNTIME>'],
    [r.cwd, '<REPO>'],
  ] as const)
    s = s.split(from).join(to)
  s = s.replace(/prj_[a-z0-9]+/g, '<PROJECT>').replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<PORT>')
  return JSON.parse(s)
}

describe('plugin: config hook', () => {
  it('installs agents, permissions, commands and compaction in a Hafiz repo', async () => {
    const r = await repo(true)
    const hooks = await plugin(r)
    const cfg: KiloConfig = {}
    await hooks.config?.(cfg)
    const n = normalise(cfg, r) as KiloConfig
    // rules text is long and has its own tests; keep the snapshot about structure
    for (const a of Object.values(n.agent ?? {}))
      if (a?.prompt) a.prompt = `<${String(a.prompt).length} chars>`
    expect(n).toMatchSnapshot()
    // native tools (default): no MCP servers, tools come from the plugin `tool` hook
    expect(cfg.mcp ?? {}).toEqual({})
    expect(Object.keys(hooks.tool ?? {})).toContain('hafiz_progress_append')
    expect(cfg.agent?.worker?.prompt).toContain('hafiz_block_set_status')
    // last match wins in Kilo permission maps: the role's allows must come after the deny
    const keys = Object.keys(cfg.agent?.worker?.permission as object)
    expect(keys.indexOf('hafiz_*')).toBeLessThan(keys.indexOf('hafiz_progress_append'))
  })

  it('host.kilo.tools: mcp registers one MCP server per role instead of native tools', async () => {
    const r = await repo(true)
    const hooks = await plugin(r, { tools: 'mcp' })
    const cfg: KiloConfig = {}
    await hooks.config?.(cfg)
    expect(hooks.tool).toBeUndefined()
    expect(Object.keys(cfg.mcp ?? {})).toEqual([
      'hafiz-manager',
      'hafiz-designer',
      'hafiz-planner',
      'hafiz-worker',
    ])
    const keys = Object.keys(cfg.agent?.worker?.permission as object)
    expect(keys.indexOf('hafiz-*')).toBeLessThan(keys.indexOf('hafiz-worker_*'))
    expect(cfg.permission).toMatchObject({ 'hafiz-*': 'deny', 'hafiz-manager_*': 'allow' })
  })

  it('re-points providers that name a base URL at the embedded proxy', async () => {
    const r = await repo(true)
    const hooks = await plugin(r, { shaper: 'proxy' })
    const cfg: KiloConfig = {
      provider: {
        mock: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://up.example/v1' } },
        builtin: { options: { apiKey: 'k' } },
      },
      agent: { worker: { model: 'mock/m', permission: { bash: 'deny' } } },
    }
    await hooks.config?.(cfg)
    expect(cfg.provider?.mock?.options?.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/mock$/)
    expect(cfg.provider?.builtin?.options).toEqual({ apiKey: 'k' })
    // user settings win, ours fill the rest
    expect(cfg.agent?.worker).toMatchObject({ model: 'mock/m', mode: 'subagent' })
    expect(cfg.agent?.worker?.permission).toMatchObject({
      bash: 'deny',
      'hafiz_*': 'deny',
      hafiz_progress_append: 'allow',
    })
  })

  it('does nothing at all outside git', async () => {
    const cwd = tmp('hafiz-nogit-')
    const env = { ...process.env, HAFIZ_STORE_ROOT: tmp('hafiz-stores-') }
    const hooks = await plugin({ cwd, env })
    expect(hooks).toEqual({})
  })
})

describe('plugin: nudge in an untracked repo', () => {
  it('counts in memory, says one line once at the threshold, and never touches a daemon', async () => {
    const r = await repo(false)
    const refuse = async () => {
      throw new Error('the daemon must not be contacted')
    }
    const hooks = await plugin(r, {}, { connect: refuse })
    const transform = async (sessionID = 's1') => {
      const system = ['You are Kilo.']
      await hooks['experimental.chat.system.transform']?.(
        { sessionID, model: { id: 'm', providerID: 'p' } },
        { system },
      )
      return system
    }
    const say = (n: number, sessionID = 's1') =>
      Promise.all(
        Array.from({ length: n }, () =>
          hooks['chat.message']?.(
            { sessionID },
            { message: {}, parts: [{ type: 'text', text: 'hi' }] },
          ),
        ),
      )
    await say(14)
    expect(await transform()).toEqual(['You are Kilo.'])
    await say(1) // turns: 15
    const tripped = await transform()
    expect(tripped).toHaveLength(2)
    expect(tripped[1]).toMatch(
      /^Hafiz: this session has 0 tool calls across 0 files in a repo Hafiz is not tracking.*hafiz_track_project/,
    )
    // once: not again on the next request, nor after much more activity
    expect(await transform()).toEqual(['You are Kilo.'])
    for (let i = 0; i < 40; i++)
      await hooks['tool.execute.after']?.(
        { tool: 'edit', sessionID: 's1', callID: `c${i}`, args: {} },
        { title: '', output: '', metadata: {} },
      )
    expect(await transform()).toEqual(['You are Kilo.'])
    // other sessions count on their own
    await say(3, 's2')
    expect(await transform('s2')).toEqual(['You are Kilo.'])
    // nothing was started or written
    expect(readdirSync(r.env.XDG_RUNTIME_DIR as string)).toEqual([])
    expect(readdirSync(r.env.HAFIZ_STORE_ROOT as string)).toEqual([])
  })

  it('file writes alone trip it, with the counts in the line', async () => {
    const r = await repo(false)
    const hooks = await plugin(r)
    for (let i = 0; i < 5; i++)
      await hooks['tool.execute.after']?.(
        { tool: i % 2 ? 'write' : 'edit', sessionID: 's1', callID: `c${i}`, args: {} },
        { title: '', output: '', metadata: {} },
      )
    const system: string[] = []
    await hooks['experimental.chat.system.transform']?.(
      { sessionID: 's1', model: { id: 'm', providerID: 'p' } },
      { system },
    )
    expect(system[0]).toContain('5 tool calls across 5 files')
  })
})

describe('plugin: Hafiz rules in agent prompts', () => {
  const config = loadConfig()
  const plan = { config, worktree: '/r', storeDir: '/s', hafiz: ['hafiz'] }
  const rules = (role: string) => `${RULES_SEPARATOR(role)}\n${rulesFor(config, role)}`

  it('appends the rules to every role agent, after a user prompt instead of under it', () => {
    const cfg: KiloConfig = {
      agent: { manager: { prompt: 'You are my manager. Be terse.', model: 'x/y' } },
    }
    const prompted = installConfig(cfg, plan)
    expect(cfg.agent?.manager?.prompt).toBe(`You are my manager. Be terse.\n\n${rules('manager')}`)
    expect(cfg.agent?.manager?.model).toBe('x/y')
    // a role agent without a user prompt is the rules alone: they must stand on their own
    expect(cfg.agent?.worker?.prompt).toBe(rules('worker'))
    expect(prompted).toEqual(['manager', 'designer', 'planner', 'worker'])
  })

  it('appends the default role rules to a primary agent with its own prompt, e.g. build', () => {
    const cfg: KiloConfig = {
      agent: {
        build: { prompt: 'House style: small commits.' },
        plan: { model: 'x/y' },
        helper: { mode: 'subagent', prompt: 'help' },
      },
    }
    const prompted = installConfig(cfg, plan)
    expect(cfg.agent?.build?.prompt).toBe(`House style: small commits.\n\n${rules('manager')}`)
    // no prompt of its own: Kilo's model-specific prompt stays, the shaper adds the rules
    expect(cfg.agent?.plan?.prompt).toBeUndefined()
    // subagents are managed only when spawned on a block: the shaper adds the rules then
    expect(cfg.agent?.helper?.prompt).toBe('help')
    expect(prompted).toEqual(['manager', 'designer', 'planner', 'worker', 'build'])
    // untracked: build is not managed yet, so its prompt stays as the user wrote it
    const untracked: KiloConfig = { agent: { build: { prompt: 'House style.' } } }
    installConfig(untracked, { ...plan, untracked: { trackTool: 'hafiz_track_project' } })
    expect(untracked.agent?.build?.prompt).toBe('House style.')
  })
})

describe('plugin: host compaction', () => {
  it('is disabled only when a condenser provider is configured', () => {
    const base = loadConfig()
    const plan = { worktree: '/r', storeDir: '/s', hafiz: ['hafiz'] }
    const none: KiloConfig = { compaction: { prune: true } }
    installConfig(none, { ...plan, config: base })
    expect(none.compaction).toEqual({ prune: true })
    const cfg = loadConfig()
    cfg.hafiz.llm.condenser.provider = 'openai-compatible'
    const on: KiloConfig = { compaction: { prune: true } }
    installConfig(on, { ...plan, config: cfg })
    expect(on.compaction).toEqual({ prune: true, auto: false })
  })
})

describe('plugin: sessions, report capture, shaping', () => {
  async function live(options: Record<string, unknown> = {}, client?: PluginInput['client']) {
    const r = await repo(true)
    const d: DaemonHandle = await startDaemon({ projectDir: r.cwd, env: r.env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    const user = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => user.close())
    await user.openSession({ id: 'cli', host: 'test', role: 'user' })
    const root = (await user.treeList())[0]?.id as string
    const { result } = await user.dispatch<{ id: string }>('block.create', {
      parent: root,
      title: 'Payments',
    })
    await user.dispatch('block.set_status', { id: result.id, status: 'active' })
    const hooks = await plugin(
      r,
      options,
      { connect: () => DaemonClient.connect(d.socketPath) },
      client,
    )
    return { r, d, hooks, block: result.id }
  }

  const ev = (type: string, properties: Record<string, unknown>) => ({
    event: { type, properties },
  })
  const text = (t: string) => [{ type: 'text', text: t }]

  async function spawnWorker(hooks: Hooks, block: string) {
    await hooks.event?.(ev('session.created', { sessionID: 'ses_m', info: { id: 'ses_m' } }))
    await hooks['chat.message']?.(
      { sessionID: 'ses_m' },
      { message: { agent: 'manager' }, parts: text('Ship payments') },
    )
    await hooks.event?.(
      ev('session.created', {
        sessionID: 'ses_w',
        info: { id: 'ses_w', parentID: 'ses_m', agent: 'worker' },
      }),
    )
    await hooks['chat.message']?.(
      { sessionID: 'ses_w', agent: 'worker' },
      { message: {}, parts: text(`hafiz:block=${block} Fix the rounding bug.`) },
    )
  }

  it('opens sessions from Kilo ids with role, parent and spawned block', async () => {
    const { d, hooks, block } = await live()
    await spawnWorker(hooks, block)
    const read = d.service.core.backend.read
    const w = await read.getSession('ses_w')
    expect(w).toMatchObject({ role: 'worker', host: 'kilo', parentSessionId: 'ses_m' })
    expect(w?.focus.blocks).toEqual([block])
    expect((await read.getSession('ses_m'))?.role).toBe('manager')
  })

  it('captures the task result as a capped report and counts the spawn', async () => {
    const { d, hooks, block } = await live()
    await spawnWorker(hooks, block)
    const long = `Fixed rounding in payments.ts.\n${'detail '.repeat(4000)}`
    const out = {
      title: 'fix',
      metadata: { sessionId: 'ses_w' },
      output: `<task id="ses_w" state="completed">\n<task_result>\n${long}\n</task_result>\n</task>`,
    }
    await hooks['tool.execute.after']?.(
      { tool: 'task', sessionID: 'ses_m', callID: 'c1', args: {} },
      out,
    )
    // the parent hears that there was no report, and (from the daemon) that the worker did not finish
    expect(out.output).toContain(
      `\nno hafiz-report in this result; full text stored on block ${block}\nended without a done request or a blocked entry\n</task_result>`,
    )
    const read = d.service.core.backend.read
    const log = await read.readLog(block, 'progress')
    expect(log).toHaveLength(1)
    const entry = log[0]?.entry as { kind: string; text: string; by: { sessionId: string } }
    expect(entry.kind).toBe('report')
    expect(entry.by.sessionId).toBe('ses_w')
    expect(entry.text).toBe(capReport(long, 1500))
    expect(entry.text).toMatch(/\n\[truncated, \d+ tokens\]$/)
    expect((await read.getSession('ses_m'))?.counters).toMatchObject({
      tool_calls: 1,
      subagents_spawned: 1,
      turns: 1,
    })
    expect((await read.getSession('ses_w'))?.endedAt).toBeDefined()
  })

  it.each(['designer', 'planner', 'worker'])(
    'captures a %s child’s report as a system action, whatever its role allowlist',
    async (role) => {
      const { d, hooks, block } = await live()
      const id = `ses_${role}`
      await hooks.event?.(ev('session.created', { sessionID: 'ses_m', info: { id: 'ses_m' } }))
      await hooks['chat.message']?.(
        { sessionID: 'ses_m' },
        { message: { agent: 'manager' }, parts: text('Ship payments') },
      )
      await hooks.event?.(
        ev('session.created', {
          sessionID: id,
          info: { id, parentID: 'ses_m', agent: role },
        }),
      )
      await hooks['chat.message']?.(
        { sessionID: id, agent: role },
        { message: {}, parts: text(`hafiz:block=${block} Do the thing.`) },
      )
      await hooks['tool.execute.after']?.(
        { tool: 'task', sessionID: 'ses_m', callID: 'c1', args: {} },
        {
          title: 't',
          metadata: { sessionId: id },
          output: `<task id="${id}" state="completed">\n<task_result>\nReport from ${role}.\n</task_result>\n</task>`,
        },
      )
      const read = d.service.core.backend.read
      const log = await read.readLog(block, 'progress')
      expect(log).toHaveLength(1)
      const entry = log[0]?.entry as { kind: string; text: string; by: { sessionId: string } }
      expect(entry).toMatchObject({ kind: 'report', text: `Report from ${role}.` })
      expect(entry.by.sessionId).toBe(id)
      const audit = (await read.readAudit()).filter((a) => a.command === 'system.progress')
      expect(audit).toHaveLength(1)
      expect(audit[0]?.by).toMatchObject({ sessionId: id, role })
    },
  )

  it('falls back to the child transcript when a (background) task goes idle', async () => {
    const asked: string[] = []
    const client: PluginInput['client'] = {
      session: {
        messages: async ({ path }) => {
          asked.push(path.id)
          const info = (role: 'user' | 'assistant', id: string) => ({
            id,
            sessionID: path.id,
            role,
          })
          return {
            data: [
              { info: info('user', 'm1'), parts: text('go') },
              {
                info: info('assistant', 'm2'),
                parts: [
                  ...text('Background report: done.'),
                  { type: 'text', text: 'x', synthetic: true },
                ],
              },
            ],
          }
        },
      },
    }
    const { d, hooks, block } = await live({}, client)
    await spawnWorker(hooks, block)
    await hooks.event?.(ev('session.idle', { sessionID: 'ses_w' }))
    await hooks.event?.(ev('session.idle', { sessionID: 'ses_m' })) // a primary session: ignored
    await new Promise((r) => setTimeout(r, 200))
    expect(asked).toEqual(['ses_w'])
    const log = await d.service.core.backend.read.readLog(block, 'progress')
    expect(log.map((e) => (e.entry as { text: string }).text)).toEqual(['Background report: done.'])
  })

  it('hooks shaper: envelope into the system prompt, old tool output stubbed', async () => {
    const { hooks, block } = await live({ shaper: 'hooks' })
    await spawnWorker(hooks, block)
    const system = ['You are Kilo.']
    await hooks['experimental.chat.system.transform']?.(
      { sessionID: 'ses_w', model: { id: 'm', providerID: 'p' } },
      { system },
    )
    expect(system).toHaveLength(2)
    expect(system[1]).toMatch(/^<hafiz hash="[0-9a-f]{12}" role="worker">/)
    expect(system[1]).toContain('Payments')

    const info = (role: 'user' | 'assistant', i: number) => ({
      id: `msg_${i}`,
      sessionID: 'ses_w',
      role,
    })
    const tool = (i: number) => ({
      type: 'tool',
      tool: 'read',
      callID: `c${i}`,
      state: { status: 'completed', output: `file contents ${i} `.repeat(200) },
    })
    const messages: KiloMessageWithParts[] = []
    for (let i = 0; i < 9; i++) {
      messages.push({ info: info('user', i * 2), parts: text(`step ${i}`) })
      messages.push({ info: info('assistant', i * 2 + 1), parts: [...text('ok'), tool(i)] })
    }
    const before = JSON.stringify(messages)
    await hooks['experimental.chat.messages.transform']?.({}, { messages })
    expect(messages).toHaveLength(18)
    expect(messages[1]?.parts[1]?.state?.output).toMatch(/^\[elided: .* — read\]$/)
    expect(messages[17]?.parts[1]?.state?.output).toContain('file contents 8')
    expect(JSON.parse(before)[1].parts[1].state.output).toContain('file contents 0')
  })

  it('proxy shaper: marks only the session agent’s own requests', async () => {
    const { hooks, block } = await live({ shaper: 'proxy' })
    await spawnWorker(hooks, block)
    const headers = async (agent: string, sessionID = 'ses_w') => {
      const o = { headers: {} as Record<string, string> }
      await hooks['chat.headers']?.({ sessionID, agent, model: { id: 'm', providerID: 'p' } }, o)
      return o.headers[SESSION_HEADER]
    }
    expect(await headers('worker')).toBe('ses_w')
    expect(await headers('title')).toBeUndefined()
    expect(await headers('build', 'ses_x')).toBeUndefined()
    expect(hooks['experimental.chat.system.transform']).toBeUndefined()
  })
})
