// Every default compliance check, driven through Core with a scripted session: it fires exactly
// once per state change, its notice names the problem, and its proposal lands in the queue.
import { describe, expect, it } from 'vitest'
import { Core } from '../commands/core.js'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import type { Actor } from '../domain/types.js'
import { MemoryBackend } from '../store/memory.js'
import type { ComplianceWhen } from './compliance.js'

const pln: Actor = { sessionId: 'p1', role: 'planner' }

async function setup() {
  const core = new Core({ config: loadConfig(), backend: new MemoryBackend(), clock: fixedClock() })
  const { result: init } = await core.projectInit(pln, { name: 'Shop', originFingerprint: 'fp' })
  const { result: block } = await core.blockCreate(pln, {
    parent: init.root.id,
    title: 'Payments',
    plan: { steps: [{ id: 's1', title: 'go' }], acceptance: ['works'] },
  })
  await core.blockSetStatus(
    { sessionId: 'm1', role: 'manager' },
    { id: block.id, status: 'active' },
  )
  const worker = async (id: string): Promise<Actor> => {
    await core.sessionOpen({ id, host: 'test', role: 'worker', spawnedBlock: block.id })
    return { sessionId: id, role: 'worker' }
  }
  const run = async (id: string, when: ComplianceWhen) =>
    (await core.complianceRun(id, when)).notices
  return { core, block: block.id, worker, run }
}

describe('compliance checks', () => {
  it('wrote_without_progress: at session end, once, with a progress proposal on the focus block', async () => {
    const { core, block, worker, run } = await setup()
    await worker('w')
    await core.countersAdd('w', { files_written: 3 })
    expect(await run('w', 'counters')).toEqual([])
    const first = await run('w', 'session_end')
    expect(first).toHaveLength(1)
    expect(first[0]?.text).toContain('wrote 3 files')
    expect(await run('w', 'session_end')).toEqual([])
    const [p, ...rest] = await core.backend.read.listProposals({ status: 'pending' })
    expect(rest).toEqual([])
    expect(p).toMatchObject({ kind: 'progress', source: 'compliance', blockId: block })
    expect(p?.payload.command).toBe('progress.append')
    expect(p?.payload.args).toMatchObject({ block, kind: 'report' })
    expect(String(p?.payload.args.text)).toContain('3 files without recording progress')
    // accepting it performs the suggested command
    await core.proposalResolve(
      { sessionId: 'u', role: 'user' },
      { id: p?.id as string, accept: true },
    )
    expect(await core.backend.read.readLog(block, 'progress')).toHaveLength(1)
  })

  it('wrote_without_progress stays quiet when progress was recorded', async () => {
    const { core, block, worker, run } = await setup()
    const w = await worker('w')
    await core.countersAdd('w', { files_written: 3 })
    await core.progressAppend(w, { block, kind: 'done', text: 'did it' })
    expect(await run('w', 'session_end')).toEqual([])
    expect(await core.backend.read.listProposals()).toEqual([])
  })

  it('silent_active_block: after 25 turns without progress; again only after progress and 25 more', async () => {
    const { core, block, worker, run } = await setup()
    const w = await worker('w')
    await core.countersAdd('w', { turns: 24 })
    expect(await run('w', 'counters')).toEqual([])
    await core.countersAdd('w', { turns: 1 })
    expect(await run('w', 'counters')).toHaveLength(1)
    await core.countersAdd('w', { turns: 5 })
    expect(await run('w', 'counters')).toEqual([]) // still true: no repeat
    await core.progressAppend(w, { block, kind: 'found', text: 'x' })
    expect(await run('w', 'counters')).toEqual([]) // reset
    await core.countersAdd('w', { turns: 25 })
    expect(await run('w', 'counters')).toHaveLength(1)
  })

  it('open_threads_at_exit: notice plus a thread.park proposal per open thread', async () => {
    const { core, block, worker, run } = await setup()
    const w = await worker('w')
    const { result: th } = await core.threadOpen(w, { block, title: 'Rounding', text: 'hmm' })
    await core.threadOpen(w, { block, title: 'Other', text: 'hm' })
    const n = await run('w', 'session_end')
    expect(n).toHaveLength(1)
    expect(n[0]?.text).toContain('2 thread(s)')
    expect(await run('w', 'session_end')).toEqual([])
    const props = await core.backend.read.listProposals({ status: 'pending' })
    expect(props).toHaveLength(2)
    expect(
      props.every((p) => p.source === 'compliance' && p.payload.command === 'thread.park'),
    ).toBe(true)
    expect(props.map((p) => p.payload.args.id)).toContain(th.id)
  })

  it('done_with_empty_log: on request_done with no progress by the session', async () => {
    const { core, block, worker, run } = await setup()
    const w = await worker('w')
    await worker('v')
    expect(await run('w', 'request_done')).toHaveLength(1)
    expect(await run('w', 'request_done')).toEqual([])
    await core.progressAppend(w, { block, kind: 'done', text: 'x' })
    expect(await run('w', 'request_done')).toEqual([])
    // another session's progress does not count for v
    expect(await run('v', 'request_done')).toHaveLength(1)
  })

  it('cap_reject_no_retry: a rejection without a retry fires once; a retry silences it', async () => {
    const { core, worker, run } = await setup()
    await worker('w')
    await worker('r')
    await core.countersAdd('w', { cap_rejections: 1 })
    expect(await run('w', 'counters')).toHaveLength(1)
    expect(await run('w', 'counters')).toEqual([])
    await core.countersAdd('r', { cap_rejections: 1, retries_after_reject: 1 })
    expect(await run('r', 'counters')).toEqual([])
  })

  it('long_unthreaded_discussion: 12 user turns on the focus block without a thread', async () => {
    const { core, block, worker, run } = await setup()
    const w = await worker('w')
    await core.countersAdd('w', { user_turns: 11 })
    expect(await run('w', 'counters')).toEqual([])
    await core.countersAdd('w', { user_turns: 1 })
    const n = await run('w', 'counters')
    expect(n).toHaveLength(1)
    expect(n[0]?.text).toContain('12 user turns')
    // opening a thread restarts the count
    await core.threadOpen(w, { block, title: 'Talk' })
    await core.countersAdd('w', { user_turns: 5 })
    expect(await run('w', 'counters')).toEqual([])
  })

  it('a session with no focus is never told it is silent or unthreaded', async () => {
    const { core, run } = await setup()
    await core.sessionOpen({ id: 'm', host: 'test', role: 'user' })
    await core.countersAdd('m', { turns: 100, user_turns: 100 })
    expect(await run('m', 'counters')).toEqual([])
  })
})
