// LLM provider `kilo`: the daemon relays condenser and drafter calls to the Kilo plugin, which
// runs them as a child session of the condensed session through the hidden `hafiz-condenser`
// agent with every tool denied. Here Kilo's SDK client is a fake that records what it is asked.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import { resolveProject } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, RpcError, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONDENSER_AGENT,
  condenserSystemHook,
  createHafizPlugin,
  type Hooks,
  type KiloClient,
  type KiloConfig,
  kiloComplete,
  kiloModel,
} from '../src/index.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

interface Call {
  op: 'create' | 'prompt'
  // biome-ignore lint/suspicious/noExplicitAny: recorded SDK arguments
  arg: any
}

/** Kilo's SDK client as far as the provider uses it; replies are scripted per system prompt. */
function fakeKilo(reply: (system: string) => string) {
  const calls: Call[] = []
  let n = 0
  const client: KiloClient = {
    session: {
      create: async (arg) => {
        calls.push({ op: 'create', arg })
        n++
        return { data: { id: `ses_child${n}`, parentID: arg.body?.parentID } }
      },
      prompt: async (arg) => {
        calls.push({ op: 'prompt', arg })
        return {
          data: {
            info: {
              id: `msg_${n}`,
              sessionID: arg.path.id,
              role: 'assistant',
              tokens: { input: 300, output: 20, reasoning: 5, cache: { read: 100, write: 0 } },
              cost: 0.0012,
            },
            parts: [
              { type: 'step-start' },
              { type: 'text', text: reply(arg.body.system ?? '') },
              { type: 'step-finish' },
            ],
          },
        }
      },
    },
  }
  return { client, calls }
}

describe('kilo provider: one completion', () => {
  it('opens a child of the session, ignores it before prompting, denies tools, parses usage', async () => {
    const { client, calls } = fakeKilo(() => '{"summary":"s","proposals":[]}')
    const ignored: string[] = []
    const r = await kiloComplete(
      {
        client,
        directory: '/repo',
        ignore: (id) => {
          ignored.push(id)
          expect(calls.map((c) => c.op)).toEqual(['create']) // before the prompt
        },
      },
      { provider: 'kilo', model: 'anthropic/claude-haiku-4-5' },
      {
        system: 'SYS',
        prompt: 'PROMPT',
        maxTokens: 100,
        json: true,
        sessionId: 'ses_p',
        purpose: 'condense',
      },
    )
    expect(calls[0]?.arg).toEqual({
      body: { parentID: 'ses_p', title: 'Hafiz: condense' },
      query: { directory: '/repo' },
    })
    expect(ignored).toEqual(['ses_child1'])
    expect(calls[1]?.arg).toEqual({
      path: { id: 'ses_child1' },
      body: {
        agent: CONDENSER_AGENT,
        model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
        system: 'SYS',
        tools: {},
        parts: [{ type: 'text', text: 'PROMPT\n\nReply with the JSON object only.' }],
      },
      query: { directory: '/repo' },
    })
    expect(r).toEqual({
      text: '{"summary":"s","proposals":[]}',
      usage: { inputTokens: 400, outputTokens: 25, cacheReadTokens: 100 },
    })
    expect(kiloModel('cheap')).toBeUndefined()
    expect(kiloModel('openrouter/google/gemini-2.5-flash')).toEqual({
      providerID: 'openrouter',
      modelID: 'google/gemini-2.5-flash',
    })
  })
})

describe('kilo provider through the plugin and the daemon', () => {
  async function rig() {
    const cwd = tmp('hafiz-repo-')
    execFileSync('git', ['init', '-q'], { cwd })
    const env = {
      ...process.env,
      HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
      XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
    }
    const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
    expect(await run(['init', 'Shop'], io)).toBe(0)
    const { storeDir } = resolveProject(cwd, env)
    mkdirSync(join(storeDir, 'config'), { recursive: true })
    writeFileSync(
      join(storeDir, 'config', 'hafiz.yaml'),
      'llm:\n  condenser: { provider: kilo, model: mock/cheap }\n' +
        '  drafters: { enabled: true, provider: kilo, model: mock/cheap }\n',
    )
    const d: DaemonHandle = await startDaemon({ projectDir: cwd, env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    const kilo = fakeKilo((system) =>
      system.includes('"gist"')
        ? 'Retries were discussed; three attempts with backoff is the working answer.'
        : '{"summary":"The user wants invoice totals in cents.","proposals":[]}',
    )
    const hooks: Hooks = await createHafizPlugin({
      env,
      hafiz: ['node', '/opt/hafiz/bin.js'],
      noCache: true,
      log: () => undefined,
      connect: () => DaemonClient.connect(d.socketPath),
    })({ directory: cwd, worktree: cwd, client: kilo.client }, {})
    cleanup.push(() => hooks.dispose?.())
    return { d, hooks, kilo }
  }

  it('registers the hidden agent; condensation runs as a child session Hafiz never manages', async () => {
    const { d, hooks, kilo } = await rig()
    const cfg: KiloConfig = {}
    await hooks.config?.(cfg)
    expect(cfg.agent?.[CONDENSER_AGENT]).toMatchObject({
      mode: 'primary',
      hidden: true,
      model: 'mock/cheap',
      permission: { '*': 'deny' },
    })
    expect(cfg.compaction).toMatchObject({ auto: false }) // Hafiz owns the tail now

    // the parent: a managed Kilo session (opening it registers the plugin as the kilo relay)
    await hooks['chat.message']?.(
      { sessionID: 'ses_parent', agent: 'manager' },
      { message: { agent: 'manager' }, parts: [{ type: 'text', text: 'hello' }] },
    )
    // backend.read is a view of the state at the time it is taken: take it fresh for every read
    const read = { getSession: (id: string) => d.service.core.backend.read.getSession(id) }
    const parent = await read.getSession('ses_parent')
    expect(parent?.role).toBe('manager')
    expect(d.service.relay.serves('kilo')).toBe(true)

    // what the shaper sends when the tail is full
    const c = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => c.close())
    c.token = parent?.token
    const r = await c.call<{ status: string }>('condense', {
      turns: [{ role: 'user', content: 'Totals must be integer cents, never floats.' }],
      through: { index: 0, fingerprint: 'fp1' },
    })
    expect(r.status).toBe('condensed')
    const created = kilo.calls.find((x) => x.op === 'create')
    expect(created?.arg.body.parentID).toBe('ses_parent')
    const prompted = kilo.calls.find((x) => x.op === 'prompt')
    expect(prompted?.arg.body).toMatchObject({ agent: CONDENSER_AGENT, tools: {} })
    expect(prompted?.arg.body.system).toContain('working memory')
    const after = await read.getSession('ses_parent')
    expect(after?.unfiledSummary).toBe('The user wants invoice totals in cents.')
    expect(after?.counters).toMatchObject({
      condensations: 1,
      condense_tokens_in: 400,
      condense_tokens_out: 25,
    })

    // Kilo now runs the child: every Hafiz hook leaves it alone
    const child = created ? 'ses_child1' : ''
    await hooks.event?.({
      event: {
        type: 'session.created',
        properties: { info: { id: child, parentID: 'ses_parent' } },
      },
    })
    await hooks['chat.message']?.(
      { sessionID: child, agent: CONDENSER_AGENT },
      { message: { agent: CONDENSER_AGENT }, parts: [{ type: 'text', text: 'PROMPT' }] },
    )
    const system = ['kilo system']
    await hooks['experimental.chat.system.transform']?.(
      { sessionID: child, model: { id: 'cheap', providerID: 'mock' } },
      { system },
    )
    const messages = [
      {
        info: { id: 'm1', sessionID: child, role: 'user' as const },
        parts: [{ type: 'text', text: 'PROMPT' }],
      },
    ]
    await hooks['experimental.chat.messages.transform']?.({}, { messages })
    await hooks['tool.execute.after']?.(
      { tool: 'read', sessionID: child, callID: 'c', args: {} },
      { title: '', output: '', metadata: {} },
    )
    expect(await read.getSession(child)).toBeNull()
    expect(system).toEqual(['kilo system'])
    expect(messages).toHaveLength(1)
  })

  it("the system transform replaces Kilo's default prompt only while a condenser child runs", async () => {
    const systems = new Map([['ses_c', 'HAFIZ SYSTEM']])
    const hook = condenserSystemHook(systems)
    const own = ['persona', 'env', 'instructions']
    await hook({ sessionID: 'ses_c' }, { system: own })
    expect(own).toHaveLength(1)
    expect(own[0]).toContain('You are a text-processing function inside Hafiz')
    expect(own[0]).toMatch(/HAFIZ SYSTEM$/)
    const other = ['persona']
    await hook({ sessionID: 'ses_other' }, { system: other })
    expect(other).toEqual(['persona'])
  })

  it('drafters run through Kilo too (a gist drafted for a thread parked without one)', async () => {
    const { d, hooks, kilo } = await rig()
    await hooks['chat.message']?.(
      { sessionID: 'ses_mgr', agent: 'manager' },
      { message: { agent: 'manager' }, parts: [{ type: 'text', text: 'hi' }] },
    )
    const read = { getSession: (id: string) => d.service.core.backend.read.getSession(id) }
    const root = (await d.service.core.treeListRaw())[0]?.id as string
    const c = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => c.close())
    c.token = (await read.getSession('ses_mgr'))?.token
    const t = await c.dispatch<{ id: string }>('thread.open', { block: root, title: 'retries' })
    const err = await c.dispatch('thread.park', { id: t.result.id }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect(String((err as Error).message)).toContain('three attempts with backoff')
    const create = kilo.calls.find((x) => x.op === 'create')
    expect(create?.arg.body).toEqual({ parentID: 'ses_mgr', title: 'Hafiz: thread gist' })
  })
})
