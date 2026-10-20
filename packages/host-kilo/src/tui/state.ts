// Which of the panel's four states is on screen, driven by Kilo's event stream, framework-free.
//   off         not a git repo: one dim line
//   untracked   git repo without a Hafiz pointer: a hint; no daemon connection, no session
//   connecting  tracked, the daemon has not answered yet
//   tracked     the full panel
// Nothing polls and nothing watches the file system. The pointer is resolved at startup and once
// more when a `hafiz_track_project` tool part completes (the only way tracking starts inside the
// Kilo session); tracking started elsewhere (`hafiz init` in a terminal) shows at the next TUI
// start. A tracked panel refreshes on events that can change what it shows, and a daemon that is
// not up yet is retried by the next such event.
import type { Located, TuiProject } from './data.js'
import type { TuiStore } from './store.js'

export const TRACK_TOOL = 'hafiz_track_project'

/** Kilo events the panel listens to. */
export const PANEL_EVENTS = [
  'message.part.updated',
  'message.updated',
  'session.idle',
  'session.status',
  'session.created',
] as const

export type PanelKind = 'off' | 'untracked' | 'connecting' | 'tracked'

export interface PanelDeps {
  locate: () => Located
  open: (p: TuiProject) => TuiStore
}

interface ToolPartLike {
  type?: string
  tool?: string
  state?: { status?: string }
}

const completedTool = (e: { properties?: Record<string, unknown> }): ToolPartLike | undefined => {
  const part = e.properties?.part as ToolPartLike | undefined
  return part?.type === 'tool' && part.state?.status === 'completed' ? part : undefined
}

export class TuiPanel {
  /** Set from the moment the project is tracked; its snapshot appears once the daemon answers. */
  store: TuiStore | undefined
  project: TuiProject | undefined
  private located: Located
  private readonly listeners = new Set<() => void>()
  private offStore: (() => void) | undefined
  private disposed = false

  constructor(private readonly deps: PanelDeps) {
    this.located = deps.locate()
    if (this.located.kind === 'tracked') this.enter(this.located.project)
  }

  get kind(): PanelKind {
    if (this.located.kind !== 'tracked') return this.located.kind
    return this.store?.snapshot ? 'tracked' : 'connecting'
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** A Kilo event. Untracked: only a completed track tool matters. Tracked: refresh. */
  onEvent(e: { type: string; properties?: Record<string, unknown> }): void {
    if (this.disposed) return
    if (this.located.kind === 'tracked') {
      if (e.type !== 'message.part.updated' || completedTool(e)?.tool?.startsWith('hafiz'))
        this.store?.kick()
      return
    }
    if (this.located.kind !== 'untracked') return
    if (completedTool(e)?.tool !== TRACK_TOOL) return
    const found = this.deps.locate()
    if (found.kind !== 'tracked') return
    this.located = found
    this.enter(found.project)
    this.emit()
  }

  private enter(project: TuiProject): void {
    this.project = project
    const store = this.deps.open(project)
    this.store = store
    this.offStore = store.subscribe(() => this.emit())
    void store.refresh()
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  dispose(): void {
    this.disposed = true
    this.offStore?.()
    this.store?.dispose()
    this.listeners.clear()
  }
}
