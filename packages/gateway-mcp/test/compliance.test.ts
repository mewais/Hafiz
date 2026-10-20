// Compliance, cost counters and drafters as the daemon wires them: cap rejections are counted
// from real dispatch errors, notices queue for the session, request_done answers inline.
import { FakeProvider, loadConfig } from '@hafiz/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonClient, QueuedNotice } from '../src/index.js'
import { connect, makeProject, startFor } from './helpers.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function boot(extra: Parameters<typeof startFor>[1] = {}) {
  const p = await makeProject()
  const d = await startFor(p, extra)
  cleanup.push(() => d.close())
  const open = async (id: string, role: string, o: { spawnedBlock?: string } = {}) => {
    const c = await connect(d)
    cleanup.push(() => c.close())
    await c.openSession({ id, host: 'test', role, ...o })
    return c
  }
  const user = await open('cli', 'user')
  const root = (await user.treeList())[0]?.id as string
  const { result } = await user.dispatch<{ id: string }>('block.create', {
    parent: root,
    title: 'Billing',
  })
  await user.dispatch('block.set_status', { id: result.id, status: 'active' })
  const worker = await open('w', 'worker', { spawnedBlock: result.id })
  return { d, user, worker, block: result.id, open }
}

const drain = (c: DaemonClient) => c.call<QueuedNotice[]>('notices.drain')
const digest = (outcome: string, pointers = [{ label: 'pr', ref: '#1' }]) => ({
  outcome,
  interface_delta: ['none'],
  pointers,
})

describe('daemon compliance', () => {
  it('counts cap rejections and retries from real errors; notifies once on a missing retry', async () => {
    const { d, worker, block } = await boot()
    const tooLong = 'word '.repeat(400)
    await expect(
      worker.dispatch('progress.append', { block, kind: 'found', text: tooLong }),
    ).rejects.toThrow(/cap/)
    let s = await d.service.core.backend.read.getSession('w')
    expect(s?.counters).toMatchObject({ cap_rejections: 1 })
    expect(s?.counters.retries_after_reject).toBeUndefined()
    // the failing call itself must not raise the alarm; the next unrelated activity does
    expect(await drain(worker)).toEqual([])
    await worker.countersAdd({ tool_calls: 1 })
    const notes = await drain(worker)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ event: 'compliance', level: 'warn' })
    expect(notes[0]?.text).toContain('exceeding its cap')
    await worker.countersAdd({ tool_calls: 1 })
    expect(await drain(worker)).toEqual([]) // once

    // a retry of the same command counts and keeps it quiet
    await expect(
      worker.dispatch('progress.append', { block, kind: 'found', text: tooLong }),
    ).rejects.toThrow()
    await worker.dispatch('progress.append', { block, kind: 'found', text: 'short' })
    s = await d.service.core.backend.read.getSession('w')
    // a rejected retry is still a retry
    expect(s?.counters).toMatchObject({ cap_rejections: 2, retries_after_reject: 2 })
    await worker.countersAdd({ tool_calls: 1 })
    expect(await drain(worker)).toEqual([])
  })

  it('request_done with an empty log answers with the notice inline, once', async () => {
    const { worker, block, d } = await boot()
    const out = await worker.dispatch('block.request_done', {
      id: block,
      digest: digest('did the thing at length'),
    })
    expect(out.notices.map((n) => n.text).join()).toContain('recorded no progress')
    await d.service.idle()
  })

  it('session end: proposals land in the review queue and managers hear about them', async () => {
    const { d, user, worker, block, open } = await boot()
    const mgr = await open('m', 'manager')
    await worker.countersAdd({ files_written: 2 })
    await worker.dispatch('thread.open', { block, title: 'Rounding', text: 'hmm' })
    await worker.call('session.end')
    const props = await user.call<Array<{ kind: string; source: string; note: string }>>(
      'proposal.list',
      {
        status: 'pending',
      },
    )
    expect(props.map((p) => `${p.kind}/${p.source}`).sort()).toEqual([
      'progress/compliance',
      'thread/compliance',
    ])
    expect(props.every((p) => p.note.startsWith('compliance:'))).toBe(true)
    expect((await drain(mgr)).filter((n) => n.event === 'proposal')).toHaveLength(2)
    // and the session's own queue kept the notices for a resume
    const queued = d.service.drainFor('w')
    expect(queued.map((n) => n.event)).toEqual(['compliance', 'compliance'])
  })

  it('cost counters: view re-emits and delta tokens are recorded per session', async () => {
    const { d, user, worker, block } = await boot()
    const v1 = await worker.contextFor()
    expect(v1.changed).toBe(true)
    await worker.contextFor() // unchanged: not counted
    await user.dispatch('decision.record', {
      block,
      title: 'Cents',
      decision: 'Integer cents.',
      standing: 'always',
    })
    const v2 = await worker.contextFor()
    expect(v2.changed).toBe(true)
    await user.dispatch('progress.append', {
      block,
      kind: 'found',
      text: 'Rounding bug in invoices.',
    })
    const delta = await worker.contextDelta()
    expect(delta.text).toContain('Rounding bug')
    const s = await d.service.core.backend.read.getSession('w')
    expect(s?.counters.view_emits).toBe(2)
    expect(s?.counters.view_tokens).toBe(v1.tokens + v2.tokens)
    expect(s?.counters.delta_tokens).toBeGreaterThan(0)
  })
})

describe('daemon drafters', () => {
  async function drafting(respond: ConstructorParameters<typeof FakeProvider>[1]) {
    const config = loadConfig()
    config.hafiz.llm.drafters = { enabled: true, provider: 'fake', model: 'fake' }
    return boot({ config, llm: { drafter: new FakeProvider('fake', respond) } })
  }

  it('thread.park without a gist gets a draft back and a gist proposal', async () => {
    const { worker, user, block } = await drafting(
      () => 'Settled on integer cents; rounding mode still open.',
    )
    const { result: th } = await worker.dispatch<{ id: string }>('thread.open', {
      block,
      title: 'Rounding',
      text: 'cents or floats?',
    })
    await expect(worker.dispatch('thread.park', { id: th.id, gist: '' })).rejects.toThrow(
      /Draft .*integer cents/,
    )
    const [p] = await user.call<
      Array<{ kind: string; source: string; payload: { command: string; args: { gist: string } } }>
    >('proposal.list', { status: 'pending' })
    expect(p).toMatchObject({
      kind: 'gist',
      source: 'drafter',
      payload: { command: 'thread.park' },
    })
    expect(p?.payload.args.gist).toContain('integer cents')
  })

  it('a thin digest at request_done gets a drafted digest proposal', async () => {
    const { worker, user, block, d } = await drafting(() => ({
      outcome: 'Rounded all money paths to integer cents and added tests.',
      interface_delta: ['none'],
      pointers: [{ label: 'file', ref: 'src/money.ts' }],
    }))
    await worker.dispatch('progress.append', {
      block,
      kind: 'done',
      text: 'money.ts now uses integer cents',
    })
    await worker.dispatch('block.request_done', { id: block, digest: digest('done') })
    await d.service.idle()
    const props = await user.call<
      Array<{ kind: string; source: string; payload: { command: string } }>
    >('proposal.list', { status: 'pending' })
    expect(props.map((p) => `${p.kind}/${p.source}`)).toContain('digest/drafter')
    const dp = props.find((p) => p.kind === 'digest')
    expect(dp?.payload.command).toBe('doc.write')
  })

  it('drafters stay off by default', async () => {
    const { worker, block, user } = await boot()
    await worker.dispatch('block.request_done', { id: block, digest: digest('done') })
    const props = await user.call<Array<{ source: string }>>('proposal.list', {})
    expect(props.some((p) => p.source === 'drafter')).toBe(false)
  })
})
