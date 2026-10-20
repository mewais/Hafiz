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
import { detectTuiProject, type TuiSnapshot, TuiSource, VIEWER_SESSION } from '../src/tui/data.js'
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
  it('no Hafiz pointer: nothing to show (the plugin registers nothing)', async () => {
    const r = await repo(false)
    expect(detectTuiProject(r.cwd, r.env)).toBeUndefined()
  })

  it('reads through a viewer session; no daemon running is an error, not a hang', async () => {
    const r = await repo(true)
    const found = detectTuiProject(r.cwd, r.env)
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

  it('polls only while watched; toasts only news, debounced into one', async () => {
    const { state, source } = fakeSource()
    state.pending = [proposal('p0')] // backlog at start: never toasted
    const toasts: ToastOut[] = []
    const store = new TuiStore(source, {
      pollMs: 20,
      toastMs: 30,
      current: () => 'ses_1',
      toast: (t) => toasts.push(t),
    })
    cleanup.push(() => store.dispose())
    let changes = 0
    store.subscribe(() => changes++)
    expect(state.reads).toBe(0) // nothing on screen, nothing read
    const release = store.watch('ses_1')
    await sleep(70)
    expect(state.reads).toBeGreaterThan(1)
    expect(changes).toBeGreaterThan(1)
    expect(store.snapshot?.pending).toHaveLength(1)

    state.pending = [proposal('p0'), proposal('p1'), proposal('p2')]
    state.notices = [
      { level: 'warn', event: 'compliance', text: 'no progress for 12 turns', ts: 't1' },
      { level: 'info', event: 'proposal', text: 'not toasted (not compliance)', ts: 't2' },
    ]
    await sleep(120)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe('warning')
    expect(toasts[0]?.message).toBe(
      '2 new proposals pending · hafiz review\nno progress for 12 turns',
    )

    release()
    const after = state.reads
    await sleep(80)
    expect(state.reads).toBeLessThanOrEqual(after + 1)
    expect(store.sessionNotices('ses_1').map((n) => n.ts)).toEqual(['t1', 't2'])
  })

  it('a failing daemon leaves the last snapshot and an error, never throws', async () => {
    const { source } = fakeSource()
    let fail = false
    const store = new TuiStore(
      {
        snapshot: () => (fail ? Promise.reject(new Error('gone')) : source.snapshot()),
        notices: source.notices,
      },
      { pollMs: 1000 },
    )
    cleanup.push(() => store.dispose())
    await store.refresh()
    fail = true
    await store.refresh()
    expect(store.snapshot?.project).toBe('Shop')
    expect(store.error).toBe('gone')
  })
})
