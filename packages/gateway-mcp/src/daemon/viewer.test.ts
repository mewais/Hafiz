// The TUI panel's daemon surface: a read_only `viewer` session reads everything the panel draws
// (tree.summary, notices.peek, block.history) and the daemon refuses every write from it. Also
// the relay that runs `llm.*.provider: kilo` in the plugin that registered for it.
import { FakeProvider, loadConfig } from '@hafiz/core'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, makeProject, startFor } from '../../test/helpers.js'
import { type DaemonClient, type DaemonHandle, RpcError } from '../index.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function boot(extra = {}) {
  const p = await makeProject()
  const d = await startFor(p, extra)
  cleanup.push(() => d.close())
  return d
}

async function as(d: DaemonHandle, id: string, role: string, spawnedBlock?: string) {
  const c = await connect(d)
  cleanup.push(() => c.close())
  await c.openSession({ id, host: 'test', role, ...(spawnedBlock ? { spawnedBlock } : {}) })
  return c
}

async function seed(u: DaemonClient) {
  const root = (await u.treeList())[0]?.id as string
  const { result } = await u.dispatch<{ id: string }>('block.create', {
    parent: root,
    title: 'Billing',
  })
  const block = result.id
  await u.dispatch('block.set_status', { id: block, status: 'active' })
  await u.dispatch('doc.write', {
    block,
    type: 'plan',
    sections: {
      steps: [
        { id: 's1', title: 'Model' },
        { id: 's2', title: 'Webhooks' },
      ],
      acceptance: ['charges succeed'],
    },
  })
  await u.dispatch('progress.append', {
    block,
    kind: 'done',
    text: 'Model done.',
    step: { id: 's1', status: 'done' },
  })
  await u.dispatch('decision.record', {
    block,
    title: 'No card data',
    decision: 'Never store card numbers.',
    standing: 'never',
  })
  await u.dispatch('thread.open', { block, title: 'retry semantics', text: 'How often?' })
  return { root, block }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (e) {
    return e instanceof RpcError ? (e.hafizCode ?? String(e.code)) : String(e)
  }
}

describe('viewer (the TUI panel)', () => {
  it('reads the tree summary, history and notices; every write is refused', async () => {
    const d = await boot()
    const u = await as(d, 'cli', 'user')
    const { block } = await seed(u)
    const v = await as(d, 'kilo-tui', 'viewer')

    const sum = await v.treeSummary()
    expect(sum.project?.name).toBe('Shop')
    const billing = sum.nodes.find((n) => n.id === block)
    expect(billing).toMatchObject({
      title: 'Billing',
      status: 'active',
      depth: 1,
      steps: { done: 1, total: 2 },
      decisions: 1,
      threads: [{ title: 'retry semantics', status: 'open' }],
    })
    expect(sum.standing.map((x) => x.title)).toEqual(['No card data'])
    expect((await v.blockHistory(block)).length).toBeGreaterThan(0)
    expect(await v.blockRead(block, 'LINE')).toContain('Billing')
    expect((await v.projectStatus()).sessions.map((s) => s.id)).toContain('cli')

    // a manager's queued notice: the viewer peeks without draining it
    const m = await as(d, 'mgr', 'manager')
    d.service.enqueue('mgr', { level: 'warn', text: 'no progress for 12 turns' }, 'compliance')
    expect((await v.noticesPeek('mgr')).map((n) => n.text)).toEqual(['no progress for 12 turns'])
    expect((await m.noticesDrain()).map((n) => n.text)).toEqual(['no progress for 12 turns'])
    expect((await v.noticesPeek('mgr')).map((n) => n.event)).toEqual(['compliance']) // still listed

    // read-only: refused whatever the method
    expect(await code(v.dispatch('block.create', { parent: block, title: 'X' }))).toBe('forbidden')
    expect(await code(v.dispatch('proposal.accept', { id: 'prop_x' }))).toBe('forbidden')
    expect(await code(v.countersAdd({ turns: 1 }))).toBe('forbidden')
    expect(await code(v.call('checkpoint.request', { session: 'mgr' }))).toBe('forbidden')
    expect(
      await code(v.call('condense', { turns: [], through: { index: 0, fingerprint: 'x' } })),
    ).toBe('forbidden')
    expect(await code(v.call('llm.serve', { providers: ['kilo'] }))).toBe('forbidden')
    expect((await d.service.core.backend.read.listBlocks()).map((b) => b.title)).not.toContain('X')
  })

  it('the viewer is not an agent: absent from status, checkpoint fan-out and live-session loops', async () => {
    const d = await boot()
    const u = await as(d, 'cli', 'user')
    await as(d, 'mgr', 'manager')
    const v = await as(d, 'kilo-tui', 'viewer')
    const ids = (await u.projectStatus()).sessions.map((s) => s.id)
    expect(ids).toContain('mgr')
    expect(ids).not.toContain('kilo-tui')
    expect((await v.projectStatus()).sessions.map((s) => s.id)).not.toContain('kilo-tui')
    const { requested } = (await u.call('checkpoint.request', { session: '*' })) as {
      requested: string[]
    }
    expect(requested).toEqual(['mgr'])
  })

  it('a role without session.status cannot peek at another session', async () => {
    const d = await boot()
    const u = await as(d, 'cli', 'user')
    const { block } = await seed(u)
    const w = await as(d, 'w1', 'worker', block)
    expect(await code(w.noticesPeek('cli'))).toBe('forbidden')
    expect(await code(w.noticesPeek())).toBe('ok')
  })
})

describe('review queue over the daemon (CLI and TUI)', () => {
  const design = (purpose: string) => ({
    purpose,
    scope: ['in: invoices'],
    interface: { provides: [{ name: 'charge()' }] },
  })

  it('list, show, accept and reject: reads for the viewer, resolving for the approver only', async () => {
    const config = loadConfig()
    config.policies.review.design = 'gate'
    const d = await boot({ config })
    const u = await as(d, 'cli', 'user')
    const { block } = await seed(u)
    const m = await as(d, 'mgr', 'manager')
    const v = await as(d, 'kilo-tui', 'viewer')
    let n = 0
    /** A designer session on the block writes its design and ends: the review ids it filed. */
    const designer = async (purpose: string) => {
      const ds = await as(d, `ds${++n}`, 'designer', block)
      await ds.dispatch('doc.patch', { block, type: 'design', sections: design(purpose) })
      return (await ds.sessionEnd()).reviews
    }

    const [id] = await designer('money in')
    expect(id).toBeTruthy()
    const [item] = await v.reviewList()
    expect(item).toMatchObject({
      id,
      kind: 'design',
      source: 'review',
      version: 1,
      mode: 'gate',
      blockId: block,
      blockTitle: 'Billing',
    })
    const shown = await v.reviewShow(id as string)
    expect(shown.doc?.version).toBe(1)
    expect(shown.text).toContain('Purpose: money in')
    // approver user: the manager hears nothing about it and may not resolve it; the viewer reads only
    expect((await m.noticesDrain()).map((x) => x.text).join()).not.toMatch(/pending review/)
    expect(await code(m.reviewAccept(id as string))).toBe('forbidden')
    expect(await code(v.reviewAccept(id as string))).toBe('forbidden')
    expect((await v.treeSummary()).nodes.find((x) => x.id === block)?.review?.design).toMatchObject(
      { proposal: id, version: 1, status: 'pending', mode: 'gate' },
    )

    // a new version replaces the pending one's payload
    expect(await designer('money in, in cents')).toEqual([id])
    expect((await u.reviewList()).map((x) => [x.id, x.version])).toEqual([[id, 2]])

    // rejected with a note: stored, and the manager hears it
    await u.reviewReject(id as string, 'say who refunds')
    expect((await m.noticesDrain()).map((x) => x.text)).toEqual([
      `design v2 of 'Billing' [${block}] rejected by user: say who refunds`,
    ])
    expect((await u.reviewList('rejected'))[0]?.resolutionNote).toBe('say who refunds')
    expect((await v.treeSummary()).nodes.find((x) => x.id === block)?.review?.design?.status).toBe(
      'rejected',
    )

    // the revision goes up again; the rejected version is still shown from the history
    const [next] = await designer('money in, in cents; refunds by support')
    expect(next).not.toBe(id)
    expect((await u.reviewShow(id as string)).text).toContain('Purpose: money in, in cents')
    await u.reviewAccept(next as string)
    expect((await m.noticesDrain()).map((x) => x.text)).toEqual([
      `design v3 of 'Billing' [${block}] approved by user`,
    ])
    const node = (await v.treeSummary()).nodes.find((x) => x.id === block)
    expect(node?.reviewed).toEqual({ design: 3 })
    expect(node?.review).toBeUndefined()
  })
})

describe('llm relay (provider kilo)', () => {
  it('runs relayed calls in the connection that owns the session; fails cleanly without one', async () => {
    const config = loadConfig()
    config.hafiz.llm.condenser = { provider: 'kilo', model: 'mock/cheap' }
    const d = await boot({ config })
    const u = await as(d, 'cli', 'user')
    await seed(u)
    const turns = [{ role: 'user', content: 'please keep invoices in cents' }]

    // nobody serves kilo yet: the condensation fails, nothing is lost
    const plugin = await as(d, 'ses_a', 'manager')
    const r0 = await plugin.call<{ status: string; notices: Array<{ text: string }> }>('condense', {
      turns,
      through: { index: 0, fingerprint: 'f0' },
    })
    expect(r0.status).toBe('failed')
    expect(r0.notices[0]?.text).toMatch(/kilo.*none is connected/)

    const seen: Array<Record<string, unknown>> = []
    await plugin.serveLlm(['kilo'], async (method, params) => {
      seen.push({ method, ...params })
      return {
        text: '{"summary":"User wants cents.","proposals":[]}',
        usage: { inputTokens: 120, outputTokens: 9 },
      }
    })
    const r1 = await plugin.call<{ status: string }>('condense', {
      turns,
      through: { index: 0, fingerprint: 'f1' },
    })
    expect(r1.status).toBe('condensed')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      method: 'llm.complete',
      provider: 'kilo',
      settings: { provider: 'kilo', model: 'mock/cheap' },
      request: { sessionId: 'ses_a', purpose: 'condense', json: true },
    })
    const s = await d.service.core.backend.read.getSession('ses_a')
    expect(s?.unfiledSummary).toBe('User wants cents.')
    expect(s?.counters).toMatchObject({ condense_tokens_in: 120, condense_tokens_out: 9 })

    // the relay goes away with its connection
    plugin.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(d.service.relay.serves('kilo')).toBe(false)
  })

  it('other providers are untouched (fake stays in the daemon)', async () => {
    const fake = new FakeProvider()
    const config = loadConfig()
    config.hafiz.llm.condenser = { provider: 'fake', model: 'fake' }
    const d = await boot({ config, llm: { condenser: fake } })
    const m = await as(d, 'ses_b', 'manager')
    const r = await m.call<{ status: string }>('condense', {
      turns: [{ role: 'user', content: 'hi' }],
      through: { index: 0, fingerprint: 'g' },
    })
    expect(r.status).toBe('condensed')
    expect(fake.requests[0]).toMatchObject({ sessionId: 'ses_b', purpose: 'condense' })
  })
})
