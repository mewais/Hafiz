// The panel's state machine driven by fake Kilo events: untracked -> tracked on a completed
// first hafiz_block_create part, daemon down -> connecting -> recovers on the next event. Fake timers
// prove nothing is scheduled while idle (no polling, no intervals).
import type { ResolvedProject } from '@hafiz/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Located, TuiProject, TuiSnapshot } from '../src/tui/data.js'
import { TuiPanel } from '../src/tui/state.js'
import { TuiStore } from '../src/tui/store.js'

const project: TuiProject = { project: { worktree: '/w/shop' } as ResolvedProject, zooms: ['FULL'] }
const snap = (): TuiSnapshot => ({
  project: 'Shop',
  nodes: [],
  standing: [],
  sessions: new Map(),
  pending: [],
  at: 0,
})
const toolPart = (tool: string, status: string) => ({
  type: 'message.part.updated',
  properties: { part: { type: 'tool', tool, state: { status } } },
})

describe('TuiPanel', () => {
  let located: Located
  let up: boolean
  let reads: number
  let locates: number
  const open = () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    const panel = new TuiPanel({
      locate: () => {
        locates++
        return located
      },
      open: () =>
        new TuiStore(
          {
            snapshot: async () => {
              reads++
              if (!up) throw new Error('no daemon')
              return snap()
            },
            notices: async () => [],
          },
          { kickMs: 5 },
        ),
    })
    return { panel, spy }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    located = { kind: 'untracked' }
    up = true
    reads = 0
    locates = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('off and untracked: no store, no connection, no timers; unrelated events do nothing', async () => {
    located = { kind: 'off' }
    const { panel, spy } = open()
    expect(panel.kind).toBe('off')
    panel.onEvent(toolPart('hafiz_block_create', 'completed'))
    expect(panel.kind).toBe('off')
    located = { kind: 'untracked' }
    const p2 = open().panel
    expect(p2.kind).toBe('untracked')
    for (const e of [
      { type: 'session.idle' },
      toolPart('bash', 'completed'),
      toolPart('hafiz_block_create', 'running'),
      toolPart('hafiz_block_create', 'error'),
    ])
      p2.onEvent(e)
    expect(p2.kind).toBe('untracked')
    expect(p2.store).toBeUndefined()
    expect(locates).toBe(2) // once per panel at construction; ignored events never look
    expect(reads).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    panel.dispose()
    p2.dispose()
  })

  it('a completed track tool switches to tracked at once; nothing polls', async () => {
    const { panel, spy } = open()
    let changes = 0
    panel.subscribe(() => changes++)
    located = { kind: 'tracked', project }
    panel.onEvent(toolPart('hafiz_block_create', 'completed'))
    expect(panel.kind).toBe('connecting') // tracked, first read in flight
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.kind).toBe('tracked')
    expect(changes).toBeGreaterThan(0)
    expect(reads).toBe(1)
    // idle: no timer, however long we wait
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toBe(1)
    expect(spy).not.toHaveBeenCalled()
    panel.dispose()
  })

  it('daemon down: connecting, retried by the next relevant event only', async () => {
    up = false
    located = { kind: 'tracked', project }
    const { panel, spy } = open()
    expect(panel.kind).toBe('connecting')
    // the sidebar mounting starts watching: one read now
    panel.store?.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.kind).toBe('connecting')
    const base = reads // the entry read and the mount's read, coalesced
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reads).toBe(base) // no backoff loop, no poll
    expect(vi.getTimerCount()).toBe(0)

    up = true
    panel.onEvent(toolPart('bash', 'completed')) // not a Hafiz tool: ignored
    await vi.advanceTimersByTimeAsync(50)
    expect(reads).toBe(base)
    panel.onEvent({ type: 'session.idle' })
    await vi.advanceTimersByTimeAsync(50)
    expect(panel.kind).toBe('tracked')
    expect(reads).toBe(base + 1)
    panel.onEvent(toolPart('hafiz_progress_append', 'completed'))
    await vi.advanceTimersByTimeAsync(50)
    expect(reads).toBe(base + 2)
    expect(spy).not.toHaveBeenCalled()
    panel.dispose()
  })

  it('tracked at startup enters directly; a failed pointer check keeps it untracked', async () => {
    located = { kind: 'tracked', project }
    const { panel } = open()
    expect(panel.store).toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(panel.kind).toBe('tracked')
    panel.dispose()

    located = { kind: 'untracked' }
    const p2 = open().panel
    p2.onEvent(toolPart('hafiz_block_create', 'completed')) // still no pointer (e.g. refused)
    expect(p2.kind).toBe('untracked')
    located = { kind: 'tracked', project }
    p2.onEvent(toolPart('hafiz_block_create', 'completed'))
    expect(p2.store).toBeDefined()
    p2.dispose()
  })
})
