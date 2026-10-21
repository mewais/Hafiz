// M1 exit scenario: init, 3-level tree with edges, parallel appends, guards, reopen, CAS, authz.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import { ConflictError, ForbiddenError, GuardError } from '../domain/errors.js'
import type { Actor, Block } from '../domain/types.js'
import { MemoryBackend } from '../store/memory.js'
import { Core } from './core.js'

const mgr: Actor = { sessionId: 'm1', role: 'manager', agent: 'manager' }
const des: Actor = { sessionId: 'd1', role: 'designer', agent: 'designer' }
const pln: Actor = { sessionId: 'p1', role: 'planner', agent: 'planner' }
const w1: Actor = { sessionId: 'w1', role: 'worker', agent: 'worker-1' }
const w2: Actor = { sessionId: 'w2', role: 'worker', agent: 'worker-2' }

const design = (purpose: string) => ({
  purpose,
  scope: ['in: x', 'out: y'],
  interface: { provides: [{ name: 'charge()', type: 'fn' }], consumes: [] },
})
const plan = {
  steps: [
    { id: 's1', title: 'scaffold' },
    { id: 's2', title: 'implement' },
  ],
  acceptance: ['tests pass'],
}
const digest = {
  outcome: 'shipped',
  interface_delta: ['none'],
  pointers: [{ label: 'pr', ref: '#1' }],
}

async function setup() {
  const core = new Core({ config: autoConfig(), backend: new MemoryBackend(), clock: fixedClock() })
  const { result: init } = await core.projectInit(mgr, {
    name: 'Shop',
    originFingerprint: 'fp',
    rootDesign: { overview: 'an online shop', topology: ['web → api → db'] },
  })
  return { core, root: init.root }
}

function autoConfig() {
  const config = loadConfig()
  config.hafiz.confirm_done = 'auto'
  return config
}

describe('core scenario', () => {
  it('builds a tree, enforces roles and guards, reopens, and tracks epochs', async () => {
    const { core, root } = await setup()
    const p0 = await core.backend.read.getProject()
    expect(p0?.epoch).toBe(1)

    // planner creates blocks; designer writes designs; worker may not create blocks
    const billing = (await core.blockCreate(pln, { parent: root.id, title: 'Billing', plan }))
      .result
    const invoices = (await core.blockCreate(pln, { parent: billing.id, title: 'Invoices', plan }))
      .result
    const payments = (await core.blockCreate(pln, { parent: billing.id, title: 'Payments', plan }))
      .result
    await expect(core.blockCreate(w1, { parent: root.id, title: 'nope' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )

    await core.docWrite(des, { block: billing.id, type: 'design', sections: design('money in') })
    await core.docWrite(des, { block: invoices.id, type: 'design', sections: design('invoices') })
    // payments consumes from invoices: the design write derives the dependency edge
    await core.docWrite(des, {
      block: payments.id,
      type: 'design',
      sections: {
        ...design('payments'),
        interface: { consumes: [{ name: 'markPaid()', type: 'fn', block: invoices.id }] },
      },
    })
    await expect(
      core.docWrite(w1, { block: payments.id, type: 'design', sections: design('x') }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(await core.backend.read.listEdges()).toEqual([
      { from: payments.id, to: invoices.id, kind: 'depends_on' },
    ])

    // CAS on designs: stale version conflicts and returns current
    const cur = (await core.backend.read.getDoc(billing.id, 'design'))?.version
    const err = await core
      .docPatch(des, {
        block: billing.id,
        type: 'design',
        sections: { purpose: 'new' },
        expectedVersion: (cur ?? 1) - 1,
      })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).details.current).toBeTruthy()

    // activation cascades to the planned parent
    await core.blockSetStatus(mgr, { id: payments.id, status: 'active' })
    expect((await core.backend.read.getBlock(billing.id))?.status).toBe('active')

    // minor writes do not bump the epoch; parallel workers never conflict
    const epochBefore = (await core.backend.read.getProject())?.epoch
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        core.progressAppend(i % 2 ? w1 : w2, {
          block: payments.id,
          kind: 'found',
          text: `finding ${i}`,
        }),
      ),
      core.stepSet(w1, { block: payments.id, stepId: 's1', status: 'done' }),
      core.stepSet(w2, { block: payments.id, stepId: 's2', status: 'doing' }),
    ])
    expect((await core.backend.read.getProject())?.epoch).toBe(epochBefore)
    expect((await core.backend.read.readLog(payments.id, 'progress')).length).toBe(10)
    await expect(
      core.stepSet(w1, { block: payments.id, stepId: 'nope', status: 'done' }),
    ).rejects.toThrow(/known: s1, s2/)

    // standing decision; superseding
    const d1 = (
      await core.decisionRecord(mgr, {
        block: root.id,
        title: 'DB',
        decision: 'Postgres, not Mongo',
        standing: 'always',
      })
    ).result
    await core.decisionRecord(mgr, {
      block: root.id,
      title: 'DB',
      decision: 'CockroachDB',
      supersedes: d1.id,
    })
    const detail = await core.blockDetailRaw(root.id)
    expect(detail.decisions.map((d) => d.status)).toEqual(['superseded', 'active'])

    // done: guards
    const th = (await core.threadOpen(w1, { block: payments.id, title: 'retry semantics?' })).result
    await expect(core.blockRequestDone(w1, { id: payments.id, digest })).rejects.toBeInstanceOf(
      GuardError,
    )
    await expect(core.threadPark(w1, { id: th.id, gist: '' })).rejects.toThrow(/gist/)
    await core.threadPark(w1, { id: th.id, gist: 'undecided between 3 and 5 retries; lean 3' })
    // worker's request_done under confirm_done: auto applies the transition and enqueues a review item
    const done = (await core.blockRequestDone(w1, { id: payments.id, digest })).result as Block
    expect(done.status).toBe('done')
    expect(done.doneAt).toBeTruthy()
    expect((await core.backend.read.listProposals({ status: 'pending' })).length).toBe(1)
    // billing cannot close while invoices is open
    await expect(
      core.blockSetStatus(mgr, { id: billing.id, status: 'done', digest }),
    ).rejects.toThrow(/child block/)

    // reopen requires a reason, marks the digest stale, bumps the epoch; re-close needs a fresh digest
    const e1 = (await core.backend.read.getProject())?.epoch ?? 0
    await expect(core.blockSetStatus(mgr, { id: payments.id, status: 'active' })).rejects.toThrow(
      /reason/,
    )
    const reopened = (
      await core.blockSetStatus(mgr, {
        id: payments.id,
        status: 'active',
        reason: 'partial refunds needed',
      })
    ).result as Block
    expect(reopened.digestStale).toBe(true)
    expect((await core.backend.read.getProject())?.epoch).toBe(e1 + 1)
    await expect(core.blockSetStatus(mgr, { id: payments.id, status: 'done' })).rejects.toThrow(
      /stale/,
    )
    const reclosed = (
      await core.blockSetStatus(mgr, {
        id: payments.id,
        status: 'done',
        digest: { ...digest, outcome: 'refunds too' },
      })
    ).result as Block
    expect(reclosed.digestStale).toBeUndefined()

    // review queue: accept marks it; audit has everything attributed
    const pending = await core.backend.read.listProposals({ status: 'pending' })
    await core.proposalResolve(mgr, { id: pending[0]?.id as string, accept: true })
    expect((await core.backend.read.listProposals({ status: 'accepted' })).length).toBe(1)
    const audit = await core.backend.read.readAudit()
    expect(audit.some((a) => a.command === 'block.set_status:done' && a.by.role === 'worker')).toBe(
      true,
    )
    expect(audit.every((a) => a.by.sessionId)).toBe(true)

    // tree listing is ordered and nested
    const tree = await core.treeListRaw()
    expect(tree.map((t) => `${'  '.repeat(t.depth)}${t.title}`)).toEqual([
      'Shop',
      '  Billing',
      '    Invoices',
      '    Payments',
    ])
  })

  it('sessions get computed focus by role and re-attach by id', async () => {
    const { core, root } = await setup()
    const a = (await core.blockCreate(pln, { parent: root.id, title: 'A' })).result
    const b = (await core.blockCreate(pln, { parent: root.id, title: 'B' })).result
    await core.blockSetStatus(mgr, { id: a.id, status: 'active' })
    const m = await core.sessionOpen({ id: 'host-1', host: 'test', role: 'manager' })
    expect(m.focus).toEqual({ blocks: [a.id], computed: true })
    const w = await core.sessionOpen({
      id: 'host-2',
      host: 'test',
      role: 'worker',
      spawnedBlock: b.id,
      parentSessionId: 'host-1',
    })
    expect(w.focus.blocks).toEqual([b.id])
    await core.focusSet({ sessionId: 'host-1', role: 'manager' }, { blocks: [a.id, b.id] })
    await core.sessionEnd('host-1')
    const again = await core.sessionOpen({ id: 'host-1', host: 'test', role: 'manager' })
    expect(again.focus).toEqual({ blocks: [a.id, b.id], computed: false })
    expect(again.token).toBe(m.token)
    expect(again.endedAt).toBeUndefined()
  })

  it('caps: soft zone notices, hard rejections with remedies', async () => {
    const { core, root } = await setup()
    const long = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ')
    const r = await core.decisionRecord(mgr, { block: root.id, title: 'ok', decision: long(100) })
    expect(r.result.id).toBeTruthy()
    await expect(
      core.decisionRecord(mgr, { block: root.id, title: 'x', decision: long(400) }),
    ).rejects.toThrow(/cap is 160/)
    await expect(
      core.docWrite(des, {
        block: root.id,
        type: 'design',
        sections: { overview: long(600), topology: ['a'] },
      }),
    ).rejects.toThrow(/Split detail/)
    // every over-cap section is reported at once, with how far over, and the soft zone once
    const err = await core
      .docWrite(des, {
        block: root.id,
        type: 'design',
        sections: { overview: long(600), topology: [long(600)] },
      })
      .catch((e) => e)
    expect(err.code).toBe('cap_exceeded')
    expect(err.message).toMatch(/2 sections are over the cap/)
    expect(err.message).toMatch(/- 'overview': \d+ tokens, cap \d+, \d+ over \(\+\d+%\)/)
    expect(err.message).toMatch(/- 'topology': /)
    expect(err.message.match(/accepted up to 15% over/g)).toHaveLength(1)
    expect(err.details.sections.map((o: { section: string }) => o.section)).toEqual([
      'overview',
      'topology',
    ])
    await expect(
      core.docWrite(des, { block: root.id, type: 'design', sections: { overview: 'x' } }),
    ).rejects.toThrow(/missing required section/)
    await expect(
      core.docWrite(des, {
        block: root.id,
        type: 'design',
        sections: { overview: 'x', topology: ['a'], bogus: 'y' },
      }),
    ).rejects.toThrow(/unknown section/)
  })
})
