// Metric collection and expectation scoring against a fixture store (in-memory Core, scripted by
// hand: a manager, two workers, one standing decision, a parked thread, cap rejections).
import { type Actor, Core, fixedClock, loadConfig, MemoryBackend } from '@hafiz/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { collectMetrics, type RunMetrics } from '../src/metrics.js'
import { holds, lookup, scoreExpectations } from '../src/score.js'

const mgr: Actor = { sessionId: 'm1', role: 'manager', agent: 'build' }
const w1: Actor = { sessionId: 'w1', role: 'worker', agent: 'worker' }
const w2: Actor = { sessionId: 'w2', role: 'worker', agent: 'worker' }
const human: Actor = { sessionId: 'cli', role: 'user' }
const digest = {
  outcome: 'Implemented.',
  interface_delta: ['none'],
  pointers: [{ label: 'file', ref: 'src/x.ts' }],
}

let metrics: RunMetrics

beforeAll(async () => {
  const core = new Core({ config: loadConfig(), backend: new MemoryBackend(), clock: fixedClock() })
  const { result: init } = await core.projectInit(human, { name: 'Shop', originFingerprint: 'fp' })
  const root = init.root.id
  const b1 = (await core.blockCreate(mgr, { parent: root, title: 'One' })).result.id
  const b2 = (await core.blockCreate(mgr, { parent: root, title: 'Two' })).result.id
  for (const id of [b1, b2]) await core.blockSetStatus(mgr, { id, status: 'active' })
  await core.sessionOpen({ id: 'm1', host: 'kilo', role: 'manager', agent: 'build' })
  await core.sessionOpen({
    id: 'w1',
    host: 'kilo',
    role: 'worker',
    parentSessionId: 'm1',
    spawnedBlock: b1,
  })
  await core.sessionOpen({
    id: 'w2',
    host: 'kilo',
    role: 'worker',
    parentSessionId: 'm1',
    spawnedBlock: b2,
  })

  // the human's own writes are not agent behaviour
  await core.decisionRecord(human, { block: root, title: 'Seed', decision: 'x', standing: 'never' })
  await core.decisionRecord(mgr, {
    block: root,
    title: 'Cents',
    decision: 'Integer cents.',
    standing: 'always',
  })
  await core.decisionRecord(mgr, { block: b1, title: 'Local', decision: 'Plain note.' })
  const th = (await core.threadOpen(mgr, { block: b2, title: 'Postgres?' })).result
  await core.threadPark(mgr, { id: th.id, gist: 'Deferred.' })
  await core.threadOpen(mgr, { block: b2, title: 'Left open' })

  await core.progressAppend(w1, { block: b1, kind: 'found', text: 'a' })
  await core.progressAppend(w1, { block: b1, kind: 'done', text: 'b' })
  await core.progressAppend(w1, { block: b1, kind: 'report', text: 'final report' })
  await core.progressAppend(w2, { block: b2, kind: 'found', text: 'c' })
  await core.stepSet(w1, { block: b1, stepId: 's1', status: 'done' }).catch(() => undefined)
  await core.blockRequestDone(w1, { id: b1, digest })
  await core.proposalAdd(
    { kind: 'progress', source: 'compliance', payload: { command: 'progress.append', args: {} } },
    mgr,
  )
  await core.proposalAdd(
    { kind: 'status', source: 'auto_done', payload: { command: 'block.set_status', args: {} } },
    mgr,
  )

  await core.countersAdd('m1', { tool_calls: 10, tool_calls_hafiz: 6, subagents_spawned: 2 })
  await core.countersAdd('w1', {
    tool_calls: 8,
    tool_calls_hafiz: 4,
    cap_rejections: 1,
    retries_after_reject: 1,
    compliance_notices: 2,
    view_emits: 2,
    view_tokens: 400,
    wire_requests: 3,
    wire_input: 100,
    wire_cache_read: 300,
  })
  await core.countersAdd('w2', { tool_calls: 2, files_written: 1 })
  metrics = await collectMetrics(core.backend.read)
})

describe('collectMetrics', () => {
  it('counts only agent writes, per role and in total', () => {
    expect(metrics.total).toMatchObject({
      sessions: 3,
      decisions: 2, // the human's seed decision is excluded
      decisions_standing: 1,
      progress: 3,
      reports: 1,
      threads_opened: 2,
      threads_parked: 1,
      threads_open_at_end: 1,
      done_requests: 1,
      done_with_digest: 1,
      blocks_created: 2,
      tool_calls: 20,
      hafiz_calls: 10,
      protocol_ratio: 0.5,
      cap_rejections: 1,
      retries: 1,
      compliance_notices: 2,
      files_written: 1,
      subagents_spawned: 2,
      proposals: 3, // the done also queues an auto-done review
      proposals_compliance: 1,
      proposals_auto_done: 2,
      proposals_drafter: 0,
    })
    expect(Object.keys(metrics.roles).sort()).toEqual(['manager', 'worker'])
    expect(metrics.roles.manager).toMatchObject({
      decisions: 2,
      threads_parked: 1,
      done_requests: 0,
    })
    expect(metrics.roles.worker).toMatchObject({
      sessions: 2,
      progress: 3,
      reports: 1,
      done_requests: 1,
      decisions: 0,
      progress_min: 1,
      progress_avg: 1.5,
    })
  })

  it('reads cost instrumentation: re-emits, tokens per view, cache ratio', () => {
    expect(metrics.roles.worker).toMatchObject({ view_emits: 2, tokens_per_view: 200 })
    expect(metrics.roles.worker?.cache_read_ratio).toBeCloseTo(0.75)
    expect(metrics.roles.manager?.cache_read_ratio).toBeNull()
  })

  it('counts store writes, not reads', () => {
    expect(metrics.total.hafiz_writes).toBeGreaterThanOrEqual(10)
    expect(metrics.roles.worker?.hafiz_writes).toBe(5) // 3 progress + 1 step + the done
  })
})

describe('expectations', () => {
  it('parses conditions', () => {
    expect(holds('>=1', 1)).toBe(true)
    expect(holds('>=1', 0)).toBe(false)
    expect(holds('==3', 3)).toBe(true)
    expect(holds(3, 3)).toBe(true)
    expect(holds('1..3', 2)).toBe(true)
    expect(holds('1..3', 4)).toBe(false)
    expect(holds('!=0', 2)).toBe(true)
    expect(holds('==0', null)).toBe(false)
    expect(() => holds('lots', 1)).toThrow(/bad expectation/)
  })

  it('looks metrics up in the total or by role (singular or plural)', () => {
    expect(lookup(metrics, 'decisions_standing')).toBe(1)
    expect(lookup(metrics, 'workers_done_requests')).toBe(1)
    expect(lookup(metrics, 'worker_progress_min')).toBe(1)
    expect(lookup(metrics, 'manager_threads_parked')).toBe(1)
    expect(lookup(metrics, 'designer_sessions')).toBeUndefined()
    expect(lookup(metrics, 'nope')).toBeUndefined()
  })

  it('scores expected against actual; unknown metrics fail', () => {
    const r = scoreExpectations(
      { decisions_standing: '>=1', workers_done_requests: '==3', nope: '==0', cap_rejections: 1 },
      metrics,
    )
    expect(r.map((x) => [x.metric, x.got, x.pass])).toEqual([
      ['decisions_standing', 1, true],
      ['workers_done_requests', 1, false],
      ['nope', undefined, false],
      ['cap_rejections', 1, true],
    ])
  })
})
