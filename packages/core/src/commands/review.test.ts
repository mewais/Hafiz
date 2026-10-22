// The review table (`policies.yaml review`): which events file a proposal, which hold the block,
// re-filing on a new version, approval pinning, approver gating and rejection notes.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import type { ReviewPolicy } from '../config/schema.js'
import { fixedClock } from '../domain/clock.js'
import type { Actor, Block, ReviewMode } from '../domain/types.js'
import type { Notice } from '../schema/validate.js'
import { MemoryBackend } from '../store/memory.js'
import { Core } from './core.js'
import type { DispatchSink } from './hooks.js'

const user: Actor = { sessionId: 'cli', role: 'user' }
const mgr: Actor = { sessionId: 'm1', role: 'manager' }
const design = {
  purpose: 'money in',
  scope: ['in: invoices'],
  interface: { provides: [{ name: 'charge()', type: 'fn' }] },
}
const plan = { steps: [{ id: 's1', title: 'build' }], acceptance: ['tests pass'] }
const digest = {
  outcome: 'shipped',
  interface_delta: ['none'],
  pointers: [{ label: 'pr', ref: '#1' }],
}

async function setup(review: Partial<ReviewPolicy> = {}) {
  const config = loadConfig()
  Object.assign(config.policies.review, review)
  const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
  const { result } = await core.projectInit(user, {
    name: 'Shop',
    originFingerprint: 'fp',
    rootDesign: { overview: 'a shop', topology: ['web → api'] },
  })
  const root = result.root.id
  const block = (await core.blockCreate(user, { parent: root, title: 'Billing' })).result
  await core.sessionOpen({ id: 'm1', host: 't', role: 'manager' })
  let n = 0
  /** One agent session of `role` that runs `fn` on the block and ends: what it filed. */
  const round = async (role: string, fn: (by: Actor) => Promise<unknown>) => {
    const id = `${role}-${++n}`
    await core.sessionOpen({ id, host: 't', role, spawnedBlock: block.id })
    await fn({ sessionId: id, role })
    return (await core.sessionEnd(id)).proposals
  }
  const designs = (sections: Record<string, unknown>) =>
    round('designer', (by) => core.docPatch(by, { block: block.id, type: 'design', sections }))
  const node = async () =>
    (await core.treeSummary(user)).nodes.find((x) => x.id === block.id) as NonNullable<
      Awaited<ReturnType<Core['treeSummary']>>['nodes'][number]
    >
  const heading = async () => (await core.blockRead(mgr, block.id, 'LINE')).split('\n')[0]
  return { core, root, block, round, designs, node, heading, read: () => core.backend.read }
}

function sink() {
  const notified: Notice[] = []
  const s: DispatchSink = {
    proposalsAdded: async () => undefined,
    enqueue: () => undefined,
    notifyReviewers: async (n) => {
      notified.push(n)
    },
  }
  return { s, notified }
}

describe('review table: design and plan rows', () => {
  it.each<ReviewMode>(['off', 'queue', 'gate'])(
    'design %s: filed at the designer session end; only gate holds the block',
    async (mode) => {
      const { core, designs, node, heading } = await setup({ design: mode })
      const filed = await designs(design)
      expect(filed).toHaveLength(mode === 'off' ? 0 : 1)
      const list = await core.reviewList(user)
      expect(list.filter((p) => p.source === 'review')).toHaveLength(mode === 'off' ? 0 : 1)
      if (mode !== 'off') {
        expect(list[0]).toMatchObject({ kind: 'design', version: 1, mode, blockTitle: 'Billing' })
        expect((await node()).review?.design).toMatchObject({ version: 1, status: 'pending', mode })
      } else expect((await node()).review).toBeUndefined()
      expect(await heading()).toMatch(mode === 'gate' ? /planned · review design$/ : /planned$/)
    },
  )

  it.each<ReviewMode>(['off', 'queue', 'gate'])(
    'plan %s: filed at the planner session end',
    async (mode) => {
      const { core, block, round, node, heading } = await setup({ plan: mode })
      await core.docWrite(user, { block: block.id, type: 'design', sections: design })
      const filed = await round('planner', (by) =>
        core.docWrite(by, { block: block.id, type: 'plan', sections: plan }),
      )
      expect(filed.map((p) => p.kind)).toEqual(mode === 'off' ? [] : ['plan'])
      expect((await node()).review?.plan?.mode).toBe(mode === 'off' ? undefined : mode)
      expect(await heading()).toMatch(mode === 'gate' ? /· review plan$/ : /planned$/)
    },
  )

  it('a newer version replaces the pending one; approval pins it and logs progress, never a decision', async () => {
    const { core, block, designs, node, read } = await setup()
    const [first] = await designs(design)
    expect(first?.note).toBe("design v1 of 'Billing': new: purpose, scope, interface (+1 provides)")
    const [again] = await designs({ scope: ['in: invoices', 'out: refunds'] })
    expect(again?.id).toBe(first?.id)
    expect(again?.payload.args.version).toBe(2)
    expect((await core.reviewList(user)).filter((p) => p.source === 'review')).toHaveLength(1)

    const { s } = sink()
    await core.dispatch(user, 'proposal.accept', { id: first?.id }, s)
    expect((await read().getBlock(block.id))?.reviewed).toEqual({ design: 2 })
    expect((await node()).review).toBeUndefined()
    const progress = (await read().readLog(block.id, 'progress')).map((x) => x.entry)
    expect(progress.at(-1)).toMatchObject({ kind: 'changed', text: 'design v2 approved by user' })
    expect(await read().readLog(block.id, 'decisions')).toEqual([])

    // changed since the approved version: section names, interface counts
    const [third] = await designs({
      interface: {
        provides: [{ name: 'charge()' }, { name: 'refund()' }],
        consumes: [{ name: 'ledger' }],
      },
    })
    expect(third?.id).not.toBe(first?.id)
    expect(third?.note).toBe(
      "design v3 of 'Billing': changed since v2: interface (+1 provides, +1 consumes)",
    )
    // show: the doc at the version under review, also for an older one from the history
    expect((await core.reviewShow(user, third?.id as string)).text).toContain('refund()')
    const old = await core.reviewShow(user, first?.id as string)
    expect(old.doc?.version).toBe(2)
    expect(old.text).not.toContain('refund()')
    expect(old.text).toContain('out: refunds')
  })

  it('accepting an older version files the newer one at once', async () => {
    const { core, block, designs, read } = await setup()
    const [p] = await designs(design)
    await core.docPatch(user, { block: block.id, type: 'design', sections: { purpose: 'money' } })
    await core.proposalResolve(user, { id: p?.id as string, accept: true })
    expect((await read().getBlock(block.id))?.reviewed).toEqual({ design: 1 })
    const pending = (await core.reviewList(user)).filter((x) => x.source === 'review')
    expect(pending.map((x) => [x.version, x.note])).toEqual([
      [2, "design v2 of 'Billing': changed since v1: purpose"],
    ])
  })

  it('block.create with an inline design files it at once, unless the creator approves reviews', async () => {
    const { core, root, read } = await setup({ approver: 'manager' })
    const { s } = sink()
    await core.sessionOpen({ id: 'd9', host: 't', role: 'designer' })
    const des: Actor = { sessionId: 'd9', role: 'designer' }
    const r = await core.dispatch(des, 'block.create', { parent: root, title: 'Ledger', design }, s)
    const ledger = r.result as Block
    const pending = (await read().listProposals({ status: 'pending' })).filter(
      (p) => p.source === 'review',
    )
    expect(pending.map((p) => [p.blockId, p.kind])).toEqual([[ledger.id, 'design']])
    await core.dispatch(mgr, 'block.create', { parent: root, title: 'Tax', design }, s)
    await core.dispatch(user, 'block.create', { parent: root, title: 'Fees', design }, s)
    expect((await read().listProposals({ status: 'pending' })).length).toBe(1)
  })
})

describe('review table: approver, rejection', () => {
  it('approver user: the manager may not resolve design reviews, but keeps other proposals', async () => {
    const { core, block, designs } = await setup()
    const [p] = await designs(design)
    await expect(core.dispatch(mgr, 'proposal.accept', { id: p?.id })).rejects.toThrow(
      /may not resolve design or plan reviews: the approver is user/,
    )
    const other = await core.proposalAdd(
      {
        kind: 'progress',
        source: 'compliance',
        blockId: block.id,
        payload: {
          command: 'progress.append',
          args: { block: block.id, kind: 'found', text: 'x' },
        },
      },
      mgr,
    )
    await core.dispatch(mgr, 'proposal.reject', { id: other?.id, note: 'not a finding' })
    expect((await core.reviewList(user, 'rejected'))[0]?.resolutionNote).toBe('not a finding')
  })

  it('approver manager: the manager resolves design reviews too', async () => {
    const { core, block, designs, read } = await setup({ approver: 'manager' })
    const [p] = await designs(design)
    await core.dispatch(mgr, 'proposal.accept', { id: p?.id })
    expect((await read().getBlock(block.id))?.reviewed).toEqual({ design: 1 })
  })

  it('a rejection stores its note, reaches the reviewers, and holds the gate until a new version', async () => {
    const { core, block, designs, node, heading } = await setup({ design: 'gate' })
    const [p] = await designs(design)
    const { s, notified } = sink()
    await core.dispatch(user, 'proposal.reject', { id: p?.id, note: 'split the index' }, s)
    expect(notified).toEqual([
      {
        level: 'warn',
        text: `design v1 of 'Billing' [${block.id}] rejected by user: split the index`,
      },
    ])
    expect((await core.reviewList(user, 'rejected'))[0]).toMatchObject({
      resolutionNote: 'split the index',
    })
    expect((await node()).review?.design).toMatchObject({
      status: 'rejected',
      resolutionNote: 'split the index',
    })
    expect(await heading()).toMatch(/· design rejected$/)
    // the same version is never filed again; a revision is
    await core.sessionOpen({ id: 'designer-1', host: 't', role: 'designer' })
    expect((await core.sessionEnd('designer-1')).proposals).toEqual([])
    const [next] = await designs({ purpose: 'money in, by index' })
    expect(next?.payload.args.version).toBe(2)
    expect((await node()).review?.design?.status).toBe('pending')
    await core.dispatch(user, 'proposal.accept', { id: next?.id }, s)
    expect(notified.at(-1)?.text).toBe(`design v2 of 'Billing' [${block.id}] approved by user`)
    expect(await heading()).toMatch(/planned$/)
  })
})

describe('review table: done and drafts rows', () => {
  async function finish(mode: ReviewMode) {
    const { core, block, read } = await setup({ done: mode })
    await core.blockSetStatus(user, { id: block.id, status: 'active' })
    const w: Actor = { sessionId: 'w1', role: 'worker' }
    const r = await core.blockRequestDone(w, { id: block.id, digest })
    const status = (await read().getBlock(block.id))?.status
    const pending = await read().listProposals({ status: 'pending' })
    return { r, status, pending }
  }

  it('off: done applies, nothing queued', async () => {
    const { status, pending } = await finish('off')
    expect(status).toBe('done')
    expect(pending).toEqual([])
  })

  it('queue: done applies and is queued for review', async () => {
    const { status, pending } = await finish('queue')
    expect(status).toBe('done')
    expect(pending.map((p) => [p.kind, p.source])).toEqual([['status', 'auto_done']])
  })

  it('gate: the request waits for the manager; set_status asks for confirmation', async () => {
    const { r, status, pending } = await finish('gate')
    expect(r.result).toMatchObject({ queued: true })
    expect(status).toBe('active')
    expect(pending).toHaveLength(1)
    const { core, block } = await setup({ done: 'gate' })
    await core.blockSetStatus(user, { id: block.id, status: 'active' })
    const ask = await core.blockSetStatus(mgr, { id: block.id, status: 'done', digest })
    expect(ask.result).toMatchObject({ needsConfirmation: true })
  })

  it('drafts off: drafter and condenser proposals are not filed; compliance ones are', async () => {
    const { core, block } = await setup({ drafts: 'off' })
    const draft = {
      kind: 'digest' as const,
      blockId: block.id,
      payload: {
        command: 'doc.write',
        args: { block: block.id, type: 'digest', sections: digest },
      },
    }
    expect(await core.proposalAdd({ ...draft, source: 'drafter' }, user)).toBeNull()
    expect(await core.proposalAdd({ ...draft, source: 'condenser' }, user)).toBeNull()
    expect(await core.proposalAdd({ ...draft, source: 'compliance' }, user)).not.toBeNull()
  })
})
