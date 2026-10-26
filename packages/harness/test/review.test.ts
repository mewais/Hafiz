// The review step between turns, the `policies:` override and the task shapes that use them.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kiloTurn, resolveReviews, writePolicies } from '../src/runner.js'
import { holds } from '../src/score.js'
import { loadTasks } from '../src/tasks.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function project(policies?: Record<string, unknown>) {
  const cwd = tmp('hafiz-h-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const root = tmp('hafiz-h-stores-')
  const env = { ...process.env, HAFIZ_STORE_ROOT: root, XDG_RUNTIME_DIR: tmp('hafiz-h-rt-') }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  expect(await run(['init', 'Shop'], io)).toBe(0)
  if (policies) writePolicies(root, policies)
  const d: DaemonHandle = await startDaemon({ projectDir: cwd, env, idleShutdownMs: 0 })
  cleanup.push(() => d.close())
  const user = await DaemonClient.connect(d.socketPath)
  cleanup.push(() => user.close())
  await user.openSession({ id: 'seed', host: 'test', role: 'user' })
  const rootBlock = (await user.treeList())[0]?.id as string
  // reviews are filed for blocks created with a design by a role that does not approve them
  const mgr = await DaemonClient.connect(d.socketPath)
  cleanup.push(() => mgr.close())
  await mgr.openSession({ id: 'mgr', host: 'test', role: 'manager' })
  return { d, user, mgr, root, rootBlock }
}

const design = {
  purpose: 'Coupons.',
  scope: ['in: coupons', 'out: payment'],
  interface: { provides: [], consumes: [] },
}

describe('review step', () => {
  it('writes the policies override into the store config and the daemon honours it', async () => {
    const { d, root } = await project({ review: { design: 'gate' } })
    const store = d.storeDir
    expect(store.startsWith(root)).toBe(true)
    expect(readFileSync(join(store, 'config', 'policies.yaml'), 'utf8')).toContain('design: gate')
  })

  it('accepts every pending proposal as the user and records them', async () => {
    const { d, user, mgr, rootBlock } = await project()
    await mgr.dispatch('block.create', { parent: rootBlock, title: 'Coupons', design })
    expect(await user.reviewList()).toHaveLength(1)
    const done = await resolveReviews(d.socketPath, 'accept')
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ kind: 'design', action: 'accept' })
    expect(done[0]?.block).toContain('coupons')
    expect(await user.reviewList()).toHaveLength(0)
  })

  it('rejects with the note', async () => {
    const { d, user, mgr, rootBlock } = await project()
    await mgr.dispatch('block.create', { parent: rootBlock, title: 'Coupons', design })
    const done = await resolveReviews(d.socketPath, 'reject', 'Cover stacking.')
    expect(done[0]).toMatchObject({ action: 'reject' })
    const all = await user.reviewList('rejected')
    expect(all[0]?.resolutionNote).toBe('Cover stacking.')
  })
})

describe('resolveReviews with mixed proposals', () => {
  it('resolves only review-sourced design and plan proposals', async () => {
    const seen: string[] = []
    const items = [
      { id: 'a', kind: 'design', source: 'review', blockId: 'b1' },
      { id: 'b', kind: 'plan', source: 'review', blockId: 'b2' },
      { id: 'c', kind: 'done', source: 'auto_done', blockId: 'b3' },
      { id: 'd', kind: 'design', source: 'drafter', blockId: 'b4' },
      { id: 'e', kind: 'compliance', source: 'compliance', blockId: 'b5' },
    ]
    const spy = vi.spyOn(DaemonClient, 'connect').mockResolvedValue({
      openSession: async () => undefined,
      reviewList: async () => items,
      reviewAccept: async (id: string) => void seen.push(id),
      reviewReject: async (id: string) => void seen.push(id),
      close: () => undefined,
    } as unknown as DaemonClient)
    cleanup.push(() => spy.mockRestore())
    const done = await resolveReviews('sock', 'accept')
    expect(seen).toEqual(['a', 'b'])
    expect(done.map((r) => [r.id, r.kind, r.block])).toEqual([
      ['a', 'design', 'b1'],
      ['b', 'plan', 'b2'],
    ])
  })
})

describe('kiloTurn timeout', () => {
  it('kills a slow binary at the hard limit even while it keeps printing', async () => {
    const dir = tmp('hafiz-h-bin-')
    const bin = join(dir, 'slow.sh')
    writeFileSync(bin, '#!/bin/sh\nwhile true; do echo tick; sleep 0.1; done\n')
    chmodSync(bin, 0o755)
    const r = await kiloTurn({
      bin,
      repo: dir,
      env: process.env,
      config: {},
      agent: 'x',
      model: 'm',
      prompt: 'p',
      timeoutMs: 1000,
      logBase: join(dir, 'turn-1'),
    })
    expect(r.code).toBe(-1)
    expect(r.ms).toBeGreaterThanOrEqual(1000)
    expect(r.ms).toBeLessThan(5000)
  })
})

describe('tasks', () => {
  it('m-feature-gated sets a 2 h turn timeout', () => {
    expect(loadTasks(undefined, ['m-feature-gated'])[0]?.turn_timeout).toBe(7200)
  })

  it('m-feature-gated declares gates and a review after turns 1 and 2', () => {
    const t = loadTasks(undefined, ['m-feature-gated'])[0]
    expect(t?.policies).toEqual({ review: { design: 'gate', plan: 'gate' } })
    expect(t?.turns.map((x) => x.review)).toEqual(['accept', 'accept', 'none'])
    expect(t?.turns.map((x) => x.prompt).slice(1)).toEqual([
      'Design approved; plan and implement it.',
      'Plans approved; proceed.',
    ])
  })

  it('expectations support <=', () => {
    expect(holds('<=2', 2)).toBe(true)
    expect(holds('<=2', 3)).toBe(false)
    expect(holds('<=2', 0)).toBe(true)
  })
})
