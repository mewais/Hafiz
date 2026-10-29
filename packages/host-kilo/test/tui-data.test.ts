// The TUI panel's data path: a viewer connection to the real daemon, and the store that polls it
// while something is on screen and turns news into (debounced) toasts.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import type { Proposal } from '@hafiz/core'
import { DaemonClient, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  projectLocator,
  type TuiSnapshot,
  TuiSource,
  USER_SESSION,
  VIEWER_SESSION,
} from '../src/tui/data.js'
import { type ToastOut, TuiStore } from '../src/tui/store.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function repo(init: boolean) {
  const cwd = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  if (init) expect(await run(['init', 'Shop'], io)).toBe(0)
  return { cwd, env }
}

describe('TUI data source', () => {
  it('locates the pointer: off outside git, untracked without one, tracked with one', async () => {
    const plain = tmp('hafiz-plain-')
    expect(projectLocator(plain, process.env)()).toEqual({ kind: 'off' })
    const r = await repo(false)
    const locate = projectLocator(r.cwd, r.env)
    expect(locate()).toEqual({ kind: 'untracked' })
    const io: Io = { cwd: r.cwd, env: r.env, out: () => undefined, err: () => undefined }
    expect(await run(['init', 'Shop'], io)).toBe(0)
    // the same locator (git dir resolved once) now sees the pointer
    expect(locate().kind).toBe('tracked')
  })

  it('reads through a viewer session; no daemon running is an error, not a hang', async () => {
    const r = await repo(true)
    const located = projectLocator(r.cwd, r.env)()
    const found = located.kind === 'tracked' ? located.project : undefined
    expect(found?.zooms).toContain('FULL')
    expect(found?.zooms).not.toContain('NONE')
    const source = new TuiSource({ project: found?.project as never, env: r.env })
    cleanup.push(() => source.close())
    await expect(source.snapshot()).rejects.toThrow() // the TUI never starts the daemon

    const d = await startDaemon({ projectDir: r.cwd, env: r.env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    cleanup.push(() => source.close()) // before the daemon closes (it waits for its clients)
    const snap = await source.snapshot()
    expect(snap.project).toBe('Shop')
    expect(snap.nodes.map((n) => n.title)).toEqual(['Shop'])
    expect(snap.pending).toEqual([])
    const viewer = await d.service.core.backend.read.getSession(VIEWER_SESSION)
    expect(viewer).toMatchObject({ role: 'viewer', host: 'kilo-tui' })
    expect(await source.blockRead(snap.nodes[0]?.id as string, 'LINE')).toContain('Shop')

    // the viewer was ended elsewhere: the source re-attaches transparently
    const u = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => u.close())
    await u.openSession({ id: VIEWER_SESSION, host: 'kilo-tui', role: 'viewer' })
    await u.sessionEnd()
    expect((await source.snapshot()).project).toBe('Shop')
  })
})

describe('TUI review actions', () => {
  it('reads the queue as the viewer; accepts and rejects as the user, nothing else', async () => {
    const r = await repo(true)
    const located = projectLocator(r.cwd, r.env)()
    const found = located.kind === 'tracked' ? located.project : undefined
    const d = await startDaemon({ projectDir: r.cwd, env: r.env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    const source = new TuiSource({ project: found?.project as never, env: r.env })
    cleanup.push(() => source.close())
    const u = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => u.close())
    await u.openSession({ id: 'cli', host: 'test', role: 'user' })
    const root = (await u.treeList())[0]?.id as string
    const block = (
      await u.dispatch<{ id: string }>('block.create', { parent: root, title: 'Orders' })
    ).result.id
    /** A designer on the block writes a design and ends: one review filed (design: queue). */
    const designer = async (id: string, purpose: string) => {
      const ds = await DaemonClient.connect(d.socketPath)
      cleanup.push(() => ds.close())
      await ds.openSession({ id, host: 'test', role: 'designer', spawnedBlock: block })
      await ds.dispatch('doc.patch', {
        block,
        type: 'design',
        sections: {
          purpose,
          scope: ['in: orders'],
          interface: { provides: [{ name: 'order()' }] },
        },
      })
      await ds.sessionEnd()
      // filed on the write: the block's one pending design review
      const pending = await d.service.core.backend.read.listProposals({ status: 'pending' })
      return pending.find((p) => p.source === 'review' && p.blockId === block)?.id as string
    }
    const first = await designer('ds1', 'orders as records')
    const snap = await source.snapshot()
    expect(snap.pending).toMatchObject([
      { id: first, kind: 'design', version: 1, mode: 'queue', blockTitle: 'Orders' },
    ])
    expect((await source.reviewShow(first)).text).toContain('Purpose: orders as records')
    // nothing opened as the user until the first write
    expect(await d.service.core.backend.read.getSession(USER_SESSION)).toBeNull()
    await source.accept(first)
    expect(await d.service.core.backend.read.getSession(USER_SESSION)).toMatchObject({
      role: 'user',
      host: 'kilo-tui',
    })
    expect((await source.snapshot()).pending).toEqual([])
    await expect(source.accept(first)).rejects.toThrow(/already accepted/)

    const second = await designer('ds2', 'orders with lines')
    const shown = await source.reviewShow(second)
    expect(shown.changed).toEqual({ since: 1, sections: ['purpose'], removed: [] })
    expect(shown.previous?.text).toContain('orders as records')
    await source.reject(second, 'say who cancels')
    const [rejected] = await u.reviewList('rejected')
    expect(rejected).toMatchObject({ id: second, resolutionNote: 'say who cancels' })
    // the viewer itself still cannot write
    const viewer = await d.service.core.backend.read.getSession(VIEWER_SESSION)
    expect(viewer?.role).toBe('viewer')
  })
})

describe('TUI store', () => {
  function fakeSource() {
    const state = {
      pending: [] as Proposal[],
      notices: [] as Array<{ level: 'info' | 'warn'; text: string; event: string; ts: string }>,
      reads: 0,
    }
    const snapshot = async (): Promise<TuiSnapshot> => {
      state.reads++
      return {
        project: 'Shop',
        nodes: [],
        standing: [],
        sessions: new Map(),
        pending: [...state.pending],
        at: Date.now(),
      }
    }
    return { state, source: { snapshot, notices: async () => [...state.notices] } }
  }
  const proposal = (id: string): Proposal => ({
    id,
    kind: 'decision',
    source: 'condenser',
    payload: { command: 'decision.record', args: {} },
    note: `note ${id}`,
    status: 'pending',
    createdAt: '2026-10-20T00:00:00Z',
  })

  it('reads on watch, never polls; toasts only news, debounced into one', async () => {
    const { state, source } = fakeSource()
    state.pending = [proposal('p0')] // backlog at start: never toasted
    const toasts: ToastOut[] = []
    const store = new TuiStore(source, {
      toastMs: 30,
      kickMs: 10,
      current: () => 'ses_1',
      toast: (t) => toasts.push(t),
    })
    cleanup.push(() => store.dispose())
    let changes = 0
    store.subscribe(() => changes++)
    expect(state.reads).toBe(0) // nothing on screen, nothing read
    const release = store.watch('ses_1')
    await sleep(70)
    expect(state.reads).toBe(1) // no timer re-reads
    expect(changes).toBe(1)
    expect(store.snapshot?.pending).toHaveLength(1)

    state.pending = [proposal('p0'), proposal('p1'), proposal('p2')]
    state.notices = [
      { level: 'warn', event: 'compliance', text: 'no progress for 12 turns', ts: 't1' },
      { level: 'info', event: 'proposal', text: 'not toasted (not compliance)', ts: 't2' },
    ]
    store.kick() // a Kilo event
    await sleep(120)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toBe(
      '2 new proposals pending · hafiz review\nno progress for 12 turns',
    )

    release()
    const after = state.reads
    store.kick() // nothing on screen: ignored
    await sleep(80)
    expect(state.reads).toBe(after)
    expect(store.sessionNotices('ses_1').map((n) => n.ts)).toEqual(['t1', 't2'])
  })

  it('a failing daemon leaves the last snapshot and an error, never throws', async () => {
    const { source } = fakeSource()
    let fail = false
    const store = new TuiStore({
      snapshot: () => (fail ? Promise.reject(new Error('gone')) : source.snapshot()),
      notices: source.notices,
    })
    cleanup.push(() => store.dispose())
    await store.refresh()
    fail = true
    await store.refresh()
    expect(store.snapshot?.project).toBe('Shop')
    expect(store.error).toBe('gone')
  })
})
