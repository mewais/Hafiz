// The state table enforced on the writes themselves (§3.2, domain/stage.ts), for roles driven
// directly (a primary agent the user talks to, spawned on no block): a plan needs the block's
// design, done needs its plan, and a gated review holds either until accepted. And work starting
// on a write (`status.activate_on.write`).
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import type { ReviewPolicy } from '../config/schema.js'
import { fixedClock } from '../domain/clock.js'
import { GuardError } from '../domain/errors.js'
import type { Actor, Block } from '../domain/types.js'
import { MemoryBackend } from '../store/memory.js'
import { Core } from './core.js'

const user: Actor = { sessionId: 'cli', role: 'user' }
const des: Actor = { sessionId: 'd1', role: 'designer', agent: 'designer' }
const pln: Actor = { sessionId: 'p1', role: 'planner', agent: 'planner' }
const wrk: Actor = { sessionId: 'w1', role: 'worker', agent: 'worker' }
const design = { purpose: 'money in', scope: ['in: charges'], interface: { provides: [] } }
const plan = { steps: [{ id: 's1', title: 'build' }], acceptance: ['tests pass'] }
const digest = {
  outcome: 'Built.',
  interface_delta: ['none'],
  pointers: [{ label: 'pr', ref: '#1' }],
}

/** Primary sessions (no spawned block) for the designer, planner and worker, as in Kilo. */
async function setup(review: Partial<ReviewPolicy> = {}) {
  const config = loadConfig()
  Object.assign(config.policies.review, review)
  const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
  const { result } = await core.projectInit(user, { name: 'Shop', originFingerprint: 'fp' })
  const root = result.root.id
  const block = (await core.blockCreate(user, { parent: root, title: 'Billing' })).result.id
  for (const a of [des, pln, wrk])
    await core.sessionOpen({ id: a.sessionId, host: 't', role: a.role, agent: a.agent as string })
  const pending = async (type: string) =>
    (await core.backend.read.listProposals({ status: 'pending' })).find(
      (p) => p.source === 'review' && p.kind === type && p.blockId === block,
    )?.id as string
  const accept = async (type: string) =>
    core.proposalResolve(user, { id: await pending(type), accept: true })
  const get = async (id = block) => (await core.backend.read.getBlock(id)) as Block
  return { core, root, block, pending, accept, get }
}

describe('a plan needs its design (doc.write / doc.patch)', () => {
  it('refuses a planner’s plan on an undesigned block, naming the writer', async () => {
    const { core, block } = await setup()
    const e = await core
      .docWrite(pln, { block, type: 'plan', sections: plan })
      .catch((x: unknown) => x)
    expect(e).toBeInstanceOf(GuardError)
    expect((e as Error).message).toMatch(
      /^cannot write the plan of Billing \[billing-\w+\]: Billing has no design yet; the designer writes it\.$/,
    )
    // nothing was written: the refusal is inside the write's transaction
    expect((await core.backend.read.getBlock(block))?.docVersions.plan).toBe(0)
  })

  it('a gated design holds the plan until the user accepts it', async () => {
    const { core, block, pending, accept } = await setup({ design: 'gate' })
    await core.docWrite(des, { block, type: 'design', sections: design })
    const id = await pending('design')
    await expect(core.docWrite(pln, { block, type: 'plan', sections: plan })).rejects.toThrow(
      `cannot write the plan of Billing [${block}]: design of Billing (v1) awaits review: hafiz review --accept ${id}.`,
    )
    await accept('design')
    expect((await core.docWrite(pln, { block, type: 'plan', sections: plan })).result.version).toBe(
      1,
    )
    // and a patch of it is checked the same way (here: passes)
    await core.docPatch(pln, { block, type: 'plan', sections: { acceptance: ['ok'] } })
  })

  it('a rejected design holds it too, with the reviewer’s note', async () => {
    const { core, block, pending } = await setup({ design: 'gate' })
    await core.docWrite(des, { block, type: 'design', sections: design })
    await core.proposalResolve(user, {
      id: await pending('design'),
      accept: false,
      note: 'who refunds?',
    })
    await expect(core.docWrite(pln, { block, type: 'plan', sections: plan })).rejects.toThrow(
      /design of Billing \(v1\) was rejected: who refunds\?; revise it/,
    )
  })

  it('a queued design does not hold the plan', async () => {
    const { core, block } = await setup({ design: 'queue' })
    await core.docWrite(des, { block, type: 'design', sections: design })
    await core.docWrite(pln, { block, type: 'plan', sections: plan })
  })

  it('the user is held by the table (no design) but not by gates it approves', async () => {
    const { core, block } = await setup({ design: 'gate' })
    await expect(core.docWrite(user, { block, type: 'plan', sections: plan })).rejects.toThrow(
      /Billing has no design yet; the designer writes it/,
    )
    await core.docWrite(des, { block, type: 'design', sections: design })
    await core.docWrite(user, { block, type: 'plan', sections: plan })
  })

  it('a planner’s split: a new child’s plan comes inline with its creation', async () => {
    const { core, block } = await setup()
    const child = await core.blockCreate(pln, { parent: block, title: 'Invoices', plan })
    expect(child.result.docVersions.plan).toBe(1)
  })
})

describe('done needs its plan (block.request_done / block.set_status done)', () => {
  async function designed(review: Partial<ReviewPolicy>) {
    const s = await setup(review)
    await s.core.docWrite(user, { block: s.block, type: 'design', sections: design })
    await s.core.blockSetStatus(user, { id: s.block, status: 'active' })
    return s
  }

  it('refuses a worker’s done request while the block has no plan', async () => {
    const { core, block } = await designed({ done: 'gate' })
    await expect(core.blockRequestDone(wrk, { id: block, digest })).rejects.toThrow(
      `cannot mark Billing [${block}] done: Billing has no plan yet; the planner writes it.`,
    )
    expect(await core.backend.read.getDoc(block, 'digest')).toBeNull()
  })

  it('a gated plan holds the request until accepted; then it is queued for the manager', async () => {
    const { core, block, pending, accept } = await designed({ plan: 'gate', done: 'gate' })
    await core.docWrite(pln, { block, type: 'plan', sections: plan })
    const id = await pending('plan')
    await expect(core.blockRequestDone(wrk, { id: block, digest })).rejects.toThrow(
      `cannot mark Billing [${block}] done: plan of Billing (v1) awaits review: hafiz review --accept ${id}.`,
    )
    await accept('plan')
    const r = await core.blockRequestDone(wrk, { id: block, digest })
    expect(r.result).toMatchObject({ queued: true })
  })

  it('set_status done is held the same way (done: off routes request_done through it)', async () => {
    const { core, block, accept, get } = await designed({ plan: 'gate', done: 'off' })
    await core.docWrite(pln, { block, type: 'plan', sections: plan })
    await expect(core.blockRequestDone(wrk, { id: block, digest })).rejects.toThrow(
      /plan of Billing \(v1\) awaits review/,
    )
    await accept('plan')
    await core.blockRequestDone(wrk, { id: block, digest })
    expect((await get()).status).toBe('done')
  })

  it('a block with children needs no plan of its own', async () => {
    const { core, block } = await designed({ done: 'off' })
    const kid = (await core.blockCreate(user, { parent: block, title: 'Kid', plan })).result.id
    await core.blockSetStatus(user, { id: kid, status: 'dropped', reason: 'not needed' })
    await core.blockSetStatus(user, { id: block, status: 'done', digest })
  })

  it('a kind whose schemas define no plan needs none', async () => {
    const config = loadConfig()
    config.kinds.kinds.spike = { schemas: { design: 'component-design', digest: 'digest' } }
    const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
    const { result } = await core.projectInit(user, { name: 'S', originFingerprint: 'fp' })
    const id = (
      await core.blockCreate(user, { parent: result.root.id, title: 'Try', kind: 'spike' })
    ).result.id
    await core.blockSetStatus(user, { id, status: 'active' })
    await core.blockSetStatus(user, { id, status: 'done', digest, confirmed: true })
  })
})

describe('work starting on a write (status.activate_on.write)', () => {
  it('a worker primary’s progress activates a planned block and its ancestors; done is then a request', async () => {
    const { core, block, get } = await setup({ done: 'gate' })
    const kid = (await core.blockCreate(user, { parent: block, title: 'Totals', design, plan }))
      .result.id
    const epoch = (await core.backend.read.getProject())?.epoch ?? 0
    await core.progressAppend(wrk, { block: kid, kind: 'found', text: 'rounding is per line' })
    expect((await get(kid)).status).toBe('active')
    expect((await get(block)).status).toBe('active')
    expect((await core.backend.read.getProject())?.epoch).toBe(epoch + 1) // progress is minor
    const r = await core.blockRequestDone(wrk, { id: kid, digest })
    expect(r.result).toMatchObject({ queued: true })
  })

  it('a step mark and a thread opened count too; other roles and Hafiz’s own notes do not', async () => {
    const { core, root, get } = await setup()
    const mk = async (title: string) =>
      (await core.blockCreate(user, { parent: root, title, design, plan })).result.id
    const [a, b, c] = [await mk('A'), await mk('B'), await mk('C')]
    await core.progressAppend(des, { block: a, kind: 'found', text: 'x' })
    await core.systemProgress(wrk, { block: a, kind: 'report', text: 'final report' })
    expect((await get(a)).status).toBe('planned')
    await core.progressAppend(wrk, {
      block: b,
      kind: 'done',
      text: 'built',
      step: { id: 's1', status: 'done' },
    })
    expect((await get(b)).status).toBe('active')
    await core.threadOpen(wrk, { block: c, title: 'which currency?' })
    expect((await get(c)).status).toBe('active')
  })

  it('an empty activate_on.write leaves the block planned', async () => {
    const config = loadConfig()
    config.policies.status.activate_on.write = []
    const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
    const { result } = await core.projectInit(user, { name: 'S', originFingerprint: 'fp' })
    const id = (await core.blockCreate(user, { parent: result.root.id, title: 'T', plan })).result
      .id
    await core.progressAppend(wrk, { block: id, kind: 'found', text: 'x' })
    expect((await core.backend.read.getBlock(id))?.status).toBe('planned')
  })
})
