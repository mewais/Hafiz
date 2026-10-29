import { loadConfig } from '@hafiz/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { attachSession, createMcpServer, DaemonClient, type DaemonHandle } from '../src/index.js'
import { makeProject, startFor } from './helpers.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

// biome-ignore lint/suspicious/noExplicitAny: parsed tool results are free-form test data
type Json = any

interface Agent {
  mcp: Client
  daemon: DaemonClient
  /** Call a tool; returns its text and isError flag. */
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>
  json(name: string, args?: Record<string, unknown>): Promise<Json>
  tools(): Promise<string[]>
}

async function agent(
  d: DaemonHandle,
  role: string,
  env: Record<string, string> = {},
  opts: { elicit?: boolean; config?: ReturnType<typeof loadConfig> } = {},
): Promise<Agent> {
  const daemon = await DaemonClient.connect(d.socketPath)
  await attachSession(daemon, role, env)
  const { server } = createMcpServer({
    role,
    client: daemon,
    ...(opts.config ? { config: opts.config } : {}),
  })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const mcp = new Client(
    { name: 'test', version: '0' },
    { capabilities: opts.elicit ? { elicitation: {} } : {} },
  )
  if (opts.elicit)
    mcp.setRequestHandler(ElicitRequestSchema, async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }))
  await server.connect(st)
  await mcp.connect(ct)
  cleanup.push(async () => {
    await mcp.close()
    daemon.close()
  })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>
      isError?: boolean
    }
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true }
  }
  return {
    mcp,
    daemon,
    call,
    async json(name, args) {
      const r = await call(name, args)
      if (r.isError) throw new Error(r.text)
      return JSON.parse(r.text.split('\n')[0] as string)
    },
    async tools() {
      return (await mcp.listTools()).tools.map((t) => t.name)
    },
  }
}

async function boot(config?: ReturnType<typeof loadConfig>) {
  const p = await makeProject()
  const d = await startFor(p, config ? { config } : {})
  cleanup.push(() => d.close())
  return { p, d }
}

const design = (purpose: string) => ({
  purpose,
  scope: ['in: x', 'out: y'],
  interface: { provides: [{ name: 'f()', type: 'fn' }] },
})
const plan = {
  steps: [
    { id: 's1', title: 'first' },
    { id: 's2', title: 'second' },
  ],
  acceptance: ['it works'],
}
const digest = {
  outcome: 'Implemented.',
  interface_delta: ['none'],
  pointers: [{ label: 'pr', ref: '#1' }],
}

// The exact tool surface per role on an MCP host: the agent catalogue narrowed by roles.yaml.
const KILO_TOOLS: Record<string, string[]> = {
  manager: [
    'hafiz_block_read',
    'hafiz_block_create',
    'hafiz_block_edit',
    'hafiz_block_set_status',
    'hafiz_doc',
    'hafiz_progress_append',
    'hafiz_decision_record',
    'hafiz_thread',
    'hafiz_review',
  ],
  designer: [
    'hafiz_block_read',
    'hafiz_block_create',
    'hafiz_doc',
    'hafiz_progress_append',
    'hafiz_decision_record',
    'hafiz_thread',
  ],
  planner: ['hafiz_block_read', 'hafiz_block_create', 'hafiz_doc', 'hafiz_thread'],
  worker: ['hafiz_block_read', 'hafiz_block_set_status', 'hafiz_progress_append', 'hafiz_thread'],
}
const CONTEXT = ['hafiz_context_for', 'hafiz_context_delta']
const TOOLS: Record<string, string[]> = {
  manager: [...CONTEXT, 'hafiz_session_status', ...(KILO_TOOLS.manager ?? [])],
  designer: [...CONTEXT, ...(KILO_TOOLS.designer ?? [])],
  planner: [...CONTEXT, ...(KILO_TOOLS.planner ?? [])],
  worker: [...CONTEXT, ...(KILO_TOOLS.worker ?? [])],
}

type ToolInfo = { name: string; description?: string; inputSchema: { properties?: unknown } }
const enumOf = (t: ToolInfo | undefined, param: string) =>
  ((t?.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>)[param]?.enum
const find = async (a: Agent, name: string) =>
  (await a.mcp.listTools()).tools.find((t) => t.name === name) as ToolInfo | undefined

describe('mcp tool lists', () => {
  it('match each role allowlist exactly', async () => {
    const { d } = await boot()
    for (const [role, expected] of Object.entries(TOOLS)) {
      const a = await agent(d, role, { HAFIZ_SESSION_ID: `s-${role}` })
      expect(await a.tools()).toEqual(expected)
    }
    const u = await agent(d, 'user', { HAFIZ_SESSION_ID: 's-user' })
    expect(await u.tools()).toHaveLength(12)
  })

  it('serving Kilo (host.kilo.tools: mcp), leaves out the context reads Kilo injects', async () => {
    const { d } = await boot()
    const daemon = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => daemon.close())
    await attachSession(daemon, 'manager', { HAFIZ_SESSION_ID: 'k' })
    expect(createMcpServer({ role: 'manager', client: daemon, host: 'kilo' }).tools).toEqual(
      KILO_TOOLS.manager,
    )
  })

  it('narrows actions and enums to the allowlist', async () => {
    const { d } = await boot()
    const w = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w' })
    expect(enumOf(await find(w, 'hafiz_block_set_status'), 'status')).toEqual(['done'])
    expect(enumOf(await find(w, 'hafiz_thread'), 'action')).toEqual(['open', 'park'])
    const p = await agent(d, 'planner', { HAFIZ_SESSION_ID: 'p' })
    expect(enumOf(await find(p, 'hafiz_doc'), 'type')).toEqual(['plan'])
    const ds = await agent(d, 'designer', { HAFIZ_SESSION_ID: 'd' })
    expect(enumOf(await find(ds, 'hafiz_progress_append'), 'kind')).toEqual(['found', 'question'])
    expect(enumOf(await find(ds, 'hafiz_doc'), 'type')).toEqual(['design'])
  })

  it('carries the mechanics in descriptions', async () => {
    const { d } = await boot()
    const w = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w' })
    const desc = Object.fromEntries(
      (await w.mcp.listTools()).tools.map((t) => [t.name, t.description ?? '']),
    )
    expect(desc.hafiz_block_set_status).toMatch(/done needs digest/)
    expect(desc.hafiz_block_set_status).toMatch(/no open threads/)
    expect(desc.hafiz_block_set_status).toMatch(/request/)
    expect(desc.hafiz_thread).toMatch(/gist \(required/)
    expect(desc.hafiz_progress_append).toMatch(/One finding/)
    const m = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'm' })
    const mdesc = Object.fromEntries(
      (await m.mcp.listTools()).tools.map((t) => [t.name, t.description ?? '']),
    )
    expect(mdesc.hafiz_decision_record).toMatch(/standing/)
    expect(mdesc.hafiz_doc).toMatch(/expected_version/)
  })
})

describe('mcp scenario', () => {
  it('manager, planner, designer and two workers drive a mini project', async () => {
    const config = loadConfig()
    config.policies.review.done = 'queue'
    const { d } = await boot(config)
    const mgr = await agent(
      d,
      'manager',
      { HAFIZ_SESSION_ID: 'mgr', HAFIZ_AGENT: 'boss' },
      { config },
    )
    const planner = await agent(d, 'planner', { HAFIZ_SESSION_ID: 'pl' }, { config })
    const designer = await agent(d, 'designer', { HAFIZ_SESSION_ID: 'ds' }, { config })

    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const a = (await planner.json('hafiz_block_create', { parent: root, title: 'Catalog' })).id
    const b = (await planner.json('hafiz_block_create', { parent: root, title: 'Checkout' })).id
    for (const id of [a, b])
      await planner.json('hafiz_doc', { block: id, type: 'plan', sections: plan, replace: true })
    await designer.json('hafiz_doc', {
      block: a,
      type: 'design',
      sections: design('Product catalog'),
    })
    // Checkout consumes from Catalog: the design write records the dependency
    const checkout = design('Checkout flow')
    await designer.json('hafiz_doc', {
      block: b,
      type: 'design',
      sections: {
        ...checkout,
        interface: { ...checkout.interface, consumes: [{ name: 'list()', block: a }] },
      },
    })
    // patching an existing doc needs the version the writer saw
    const stale = await designer.call('hafiz_doc', {
      block: a,
      type: 'design',
      sections: { purpose: 'Catalog of products' },
    })
    expect(stale.isError).toBe(true)
    expect(stale.text).toMatch(/expected_version: 1/)
    await designer.json('hafiz_doc', {
      block: a,
      type: 'design',
      sections: { purpose: 'Catalog of products' },
      expected_version: 1,
    })
    expect((await mgr.call('hafiz_block_read', { id: b, zoom: 'DESIGN' })).text).toContain(
      `Depends on: ${a}`,
    )
    await mgr.json('hafiz_block_set_status', { id: a, status: 'active' })
    await mgr.json('hafiz_block_set_status', { id: b, status: 'active' })

    const w1 = await agent(
      d,
      'worker',
      {
        HAFIZ_SESSION_ID: 'w1',
        HAFIZ_BLOCK: a,
        HAFIZ_PARENT_SESSION: 'mgr',
      },
      { config },
    )
    const w2 = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w2', HAFIZ_BLOCK: b }, { config })

    // a worker cannot set any other status, and the daemon refuses set_status anyway
    expect((await w1.call('hafiz_block_set_status', { id: a, status: 'active' })).isError).toBe(
      true,
    )
    await expect(
      w1.daemon.dispatch('block.set_status', { id: a, status: 'done' }),
    ).rejects.toMatchObject({
      hafizCode: 'forbidden',
    })

    // workers append progress and steps in parallel
    await Promise.all([
      ...[1, 2, 3].map((i) =>
        w1.json('hafiz_progress_append', { block: a, kind: 'found', text: `catalog finding ${i}` }),
      ),
      ...[1, 2, 3].map((i) =>
        w2.json('hafiz_progress_append', {
          block: b,
          kind: 'changed',
          text: `checkout change ${i}`,
        }),
      ),
      w1.json('hafiz_progress_append', {
        block: a,
        kind: 'done',
        text: 'catalog step done',
        step: { id: 's1', status: 'done' },
      }),
      w2.json('hafiz_progress_append', {
        block: b,
        kind: 'found',
        text: 'checkout step started',
        step: { id: 's1', status: 'doing' },
      }),
    ])

    // per-role views differ, and each worker sees its own block
    const mv = (await mgr.call('hafiz_context_for')).text
    const v1 = (await w1.call('hafiz_context_for')).text
    const v2 = (await w2.call('hafiz_context_for')).text
    expect(mv).not.toBe(v1)
    expect(v1).not.toBe(v2)
    expect(mv).toContain('Checkout')
    expect(v1).toContain('Catalog')
    expect(mv).toMatch(/\[view \w+ · /)

    // too-long progress is rejected with the remedy, not swallowed
    const long = await w1.call('hafiz_progress_append', {
      block: a,
      kind: 'found',
      text: 'word '.repeat(400),
    })
    expect(long.isError).toBe(true)
    expect(long.text).toContain('One finding per entry')

    // an open thread blocks done; parking it needs a gist
    const th = await w1.json('hafiz_thread', { action: 'open', block: a, title: 'Pagination?' })
    const early = await w1.call('hafiz_block_set_status', { id: a, status: 'done', digest })
    expect(early.isError).toBe(true)
    expect(early.text).toMatch(/thread/i)
    const blank = await w1.call('hafiz_thread', { action: 'park', id: th.id, gist: '   ' })
    expect(blank.isError).toBe(true)
    await w1.json('hafiz_thread', {
      action: 'park',
      id: th.id,
      gist: 'Cursor vs offset; leaning cursor.',
    })

    // the worker's done is a request (auto policy closes it) and the manager is told
    await w1.call('hafiz_block_set_status', { id: a, status: 'done', digest })
    const tree = (await mgr.call('hafiz_block_read')).text
    expect(tree).toMatch(new RegExp(`\\[done\\] ${a}`))
    const props = await mgr.json('hafiz_review', { action: 'list' })
    expect(props).toHaveLength(1)
    // the pending notice rides along on the manager's next call (one call earlier drained it)
    expect(tree + (await mgr.call('hafiz_block_read')).text).toBeTruthy()

    // the manager's focus follows active blocks: Catalog is now done, Checkout remains
    const st = await mgr.json('hafiz_session_status')
    expect(st.session.focus.blocks).toEqual([b])
    expect(st.session.counters.tool_calls_hafiz).toBeGreaterThan(5)
  })

  it('tells the manager when a worker queued a proposal', async () => {
    const { d } = await boot()
    const mgr = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' })
    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const blk = (await mgr.json('hafiz_block_create', { parent: root, title: 'Search' })).id
    await mgr.json('hafiz_block_set_status', { id: blk, status: 'active' })
    const w = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w', HAFIZ_BLOCK: blk })
    await w.call('hafiz_block_set_status', { id: blk, status: 'done', digest })
    const next = await mgr.call('hafiz_block_read')
    expect(next.text).toMatch(/\[proposal\] proposal prop_\w+ pending review/)
  })

  it('re-attaches the same session on reconnect (same focus)', async () => {
    const { d } = await boot()
    const mgr = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' })
    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const a = (await mgr.json('hafiz_block_create', { parent: root, title: 'Alpha' })).id
    const b = (await mgr.json('hafiz_block_create', { parent: root, title: 'Beta' })).id
    await mgr.json('hafiz_block_set_status', { id: a, status: 'active' })
    await mgr.json('hafiz_block_set_status', { id: b, status: 'active' })
    const w = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w', HAFIZ_BLOCK: a })
    const before = (await w.call('hafiz_context_for')).text
    const mBefore = await mgr.json('hafiz_session_status')

    // both hosts drop and come back with the same session id (no HAFIZ_BLOCK needed the second time)
    const mgr2 = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' })
    const w2 = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w' })
    const after = (await w2.call('hafiz_context_for')).text
    expect(after.replace(/\[view.*\]/, '')).toBe(before.replace(/\[view.*\]/, ''))
    const mAfter = await mgr2.json('hafiz_session_status')
    expect(mAfter.session.focus).toEqual(mBefore.session.focus)
    expect(mAfter.session.focus.blocks).toEqual(expect.arrayContaining([a, b]))
    expect(mAfter.session.counters.tool_calls_hafiz).toBeGreaterThanOrEqual(
      mBefore.session.counters.tool_calls_hafiz,
    )
    const status = await d.service.core.backend.read.listSessions()
    expect(status.filter((s) => s.id === 'w')).toHaveLength(1)
    expect(status.find((s) => s.id === 'w')?.focus.blocks).toEqual([a])
  })

  it('adopts an adapter-minted HAFIZ_TOKEN without opening a session', async () => {
    const { d } = await boot()
    const adapter = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => adapter.close())
    const s = await adapter.openSession({ id: 'minted', host: 'kilo', role: 'worker' })
    const w = await agent(d, 'worker', { HAFIZ_TOKEN: s.token })
    expect((await w.call('hafiz_context_for')).isError).toBe(false)
    const sessions = await d.service.core.backend.read.listSessions()
    expect(sessions.map((x) => x.id)).toEqual(['minted'])
  })
})

describe('mcp confirmation', () => {
  const gateConfig = () => {
    const c = loadConfig()
    c.policies.review.done = 'gate'
    return c
  }
  async function setup(elicit: boolean) {
    const config = gateConfig()
    const { d } = await boot(config)
    const mgr = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' }, { elicit, config })
    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const blk = (await mgr.json('hafiz_block_create', { parent: root, title: 'Ship' })).id
    await mgr.json('hafiz_block_set_status', { id: blk, status: 'active' })
    return { mgr, blk }
  }

  it('returns the instruction when the client cannot elicit', async () => {
    const { mgr, blk } = await setup(false)
    const r = await mgr.call('hafiz_block_set_status', { id: blk, status: 'done', digest })
    expect(r.text).toMatch(/requires confirmation/)
    expect(r.text).toMatch(/confirmed: true/)
    expect((await mgr.call('hafiz_block_read')).text).toContain(`[active] ${blk}`)
    const ok = await mgr.call('hafiz_block_set_status', {
      id: blk,
      status: 'done',
      digest,
      confirmed: true,
    })
    expect(ok.isError).toBe(false)
    expect((await mgr.call('hafiz_block_read')).text).toContain(`[done] ${blk}`)
  })

  it('elicits yes/no and retries when the client supports it', async () => {
    const { mgr, blk } = await setup(true)
    await mgr.call('hafiz_block_set_status', { id: blk, status: 'done', digest })
    expect((await mgr.call('hafiz_block_read')).text).toContain(`[done] ${blk}`)
  })

  it('queues a worker request for review under review.done: gate', async () => {
    const config = gateConfig()
    const { d } = await boot(config)
    const mgr = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' }, { config })
    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const blk = (await mgr.json('hafiz_block_create', { parent: root, title: 'Ship' })).id
    await mgr.json('hafiz_block_set_status', { id: blk, status: 'active' })
    const w = await agent(d, 'worker', { HAFIZ_SESSION_ID: 'w', HAFIZ_BLOCK: blk }, { config })
    const r = await w.json('hafiz_block_set_status', { id: blk, status: 'done', digest })
    expect(r.queued).toBe(true)
    expect((await mgr.call('hafiz_block_read')).text).toContain(`[active] ${blk}`)
    const [p] = await mgr.json('hafiz_review', { action: 'list' })
    await mgr.json('hafiz_review', { action: 'accept', id: p.id })
    expect((await mgr.call('hafiz_block_read')).text).toContain(`[done] ${blk}`)
  })
})

describe('mcp resources and prompts', () => {
  it('serves hafiz://context, hafiz://block/{id} and one prompt per role', async () => {
    const { d } = await boot()
    const mgr = await agent(d, 'manager', { HAFIZ_SESSION_ID: 'mgr' })
    const root = (await mgr.call('hafiz_block_read')).text.match(/\] (\S+) —/)?.[1] as string
    const ctx = await mgr.mcp.readResource({ uri: 'hafiz://context' })
    expect((ctx.contents[0] as { text: string }).text).toContain('Shop')
    const blk = await mgr.mcp.readResource({ uri: `hafiz://block/${root}` })
    expect((blk.contents[0] as { text: string }).text).toContain('Shop')
    const prompts = (await mgr.mcp.listPrompts()).prompts.map((p) => p.name).sort()
    expect(prompts).toEqual([
      'hafiz_designer',
      'hafiz_manager',
      'hafiz_planner',
      'hafiz_user',
      'hafiz_viewer',
      'hafiz_worker',
    ])
    const pr = await mgr.mcp.getPrompt({ name: 'hafiz_worker' })
    const first = pr.messages[0]?.content as { text: string }
    expect(first.text).toContain('worker')
  })
})
