// Live data for the panel, framework-free (the Solid components subscribe to it). Reads go
// through TuiSource; nothing here writes. No timer polls: a refresh runs when something
// on screen starts watching (sidebar, status chip, the /hafiz route) and when a Kilo event that
// can change the data arrives (`kick`, debounced once; nothing is scheduled while idle).
// A slow or absent daemon never blocks rendering: views draw the last snapshot (or nothing).
import type { QueuedNotice } from '@hafiz/gateway-mcp/client'
import type { TuiSnapshot, TuiSource } from './data.js'
import { fresh } from './model.js'

export interface ToastOut {
  variant: 'info' | 'warning'
  title: string
  message: string
}

export interface TuiStoreOptions {
  /** Debounce for event-triggered refreshes. */
  kickMs?: number
  /** Debounce for toasts: news within this window becomes one toast. */
  toastMs?: number
  /** The Kilo session on screen; its compliance notices are toasted. */
  current?: () => string | undefined
  toast?: (t: ToastOut) => void
  log?: (line: string) => void
}

type Timer = ReturnType<typeof setTimeout>

export class TuiStore {
  snapshot: TuiSnapshot | undefined
  error: string | undefined
  private readonly notices = new Map<string, QueuedNotice[]>()
  private readonly listeners = new Set<() => void>()
  private readonly watched = new Map<string, number>()
  private watchers = 0
  private kickTimer: Timer | undefined
  private inflight: Promise<void> | undefined
  private again = false
  private disposed = false
  // toasts
  private readonly seenProposals = new Set<string>()
  private readonly seenNotices = new Set<string>()
  private primedProposals = false
  private readonly primedNotices = new Set<string>()
  private pendingToasts: ToastOut[] = []
  private toastTimer: Timer | undefined

  constructor(
    private readonly source: Pick<TuiSource, 'snapshot' | 'notices'>,
    private readonly opts: TuiStoreOptions = {},
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  sessionNotices(sessionId: string | undefined): QueuedNotice[] {
    return (sessionId && this.notices.get(sessionId)) || []
  }

  /** Something on screen shows the data (for `sessionId`, if given); reads once now. */
  watch(sessionId?: string): () => void {
    this.watchers++
    if (sessionId) this.watched.set(sessionId, (this.watched.get(sessionId) ?? 0) + 1)
    void this.refresh()
    let released = false
    return () => {
      if (released) return
      released = true
      this.watchers--
      if (sessionId) {
        const n = (this.watched.get(sessionId) ?? 1) - 1
        if (n > 0) this.watched.set(sessionId, n)
        else this.watched.delete(sessionId)
      }
    }
  }

  /** A Kilo event that may have changed something: refresh soon (debounced). */
  kick(): void {
    if (this.disposed || this.watchers === 0) return
    if (this.kickTimer) return
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined
      void this.refresh()
    }, this.opts.kickMs ?? 300)
  }

  /** Read everything once; concurrent calls coalesce into at most one more read. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inflight) {
      this.again = true
      return this.inflight
    }
    this.inflight = this.load().finally(() => {
      this.inflight = undefined
      if (this.again && !this.disposed) {
        this.again = false
        void this.refresh()
      }
    })
    return this.inflight
  }

  private async load(): Promise<void> {
    const current = this.opts.current?.()
    const ids = new Set([...this.watched.keys(), ...(current ? [current] : [])])
    try {
      const [snap, ...notes] = await Promise.all([
        this.source.snapshot(),
        ...[...ids].map((id) => this.source.notices(id)),
      ])
      this.snapshot = snap
      this.error = undefined
      for (const [i, id] of [...ids].entries()) this.notices.set(id, notes[i] ?? [])
      this.collectToasts(snap, current)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
    for (const fn of this.listeners) fn()
  }

  private collectToasts(snap: TuiSnapshot, current: string | undefined): void {
    const props = fresh(this.seenProposals, this.primedProposals, snap.pending, (p) => p.id)
    this.primedProposals = true
    if (props.length)
      this.queueToast({
        variant: 'info',
        title: 'Hafiz review',
        message:
          props.length === 1
            ? `new proposal: ${props[0]?.note ?? props[0]?.kind} · hafiz review`
            : `${props.length} new proposals pending · hafiz review`,
      })
    if (!current) return
    const notes = (this.notices.get(current) ?? []).filter((n) => n.event === 'compliance')
    const news = fresh(
      this.seenNotices,
      this.primedNotices.has(current),
      notes,
      (n) => `${current}|${n.ts}|${n.text}`,
    )
    this.primedNotices.add(current)
    for (const n of news)
      this.queueToast({
        variant: n.level === 'warn' ? 'warning' : 'info',
        title: 'Hafiz',
        message: n.text,
      })
  }

  private queueToast(t: ToastOut): void {
    if (!this.opts.toast) return
    this.pendingToasts.push(t)
    if (this.toastTimer) return
    this.toastTimer = setTimeout(() => {
      this.toastTimer = undefined
      const all = this.pendingToasts.splice(0)
      if (!all.length || this.disposed) return
      const first = all[0] as ToastOut
      this.opts.toast?.(
        all.length === 1
          ? first
          : {
              variant: all.some((x) => x.variant === 'warning') ? 'warning' : 'info',
              title: 'Hafiz',
              message: all.map((x) => x.message).join('\n'),
            },
      )
    }, this.opts.toastMs ?? 1500)
  }

  dispose(): void {
    this.disposed = true
    for (const t of [this.kickTimer, this.toastTimer]) if (t) clearTimeout(t)
    this.listeners.clear()
  }
}
