// The Hafiz panel in Kilo's TUI (a separate module: `hafiz-kilo/tui`): a sidebar section with
// the block tree, a status chip next to the prompt, toasts for new review items and compliance
// notices, a full-screen `/hafiz` route (Tree / Review / Decisions / Notices) and the review
// overlay (review.tsx). The panel reads as a `viewer`; its only writes are the overlay's accept
// and reject, as the `user` role. Everything else goes through agents or the `hafiz` CLI.
//
// Kilo loads this file in its TUI thread (the server plugin runs in a worker), compiled from Solid
// JSX with `generate: universal` against `@opentui/solid`; Kilo maps `solid-js` and `@opentui/*`
// imports onto its own runtime instances (scripts/bundle.mjs). In a repo without a Hafiz pointer
// it
// shows its state instead: `off` (not git), `untracked` (a hint), `connecting`, or the full tree.
// Everything is registered at startup; `TuiPanel` (state.ts) switches on Kilo events, no timers.
import { basename } from 'node:path'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { projectLocator, type TuiSnapshot, TuiSource } from './data.js'
import type { TuiApi, TuiPlugin } from './kilo-tui.js'
import {
  connectingLines,
  decisionLines,
  historyLines,
  inactiveLines,
  type Line,
  nextDetail,
  noticeLines,
  REVIEW_KEY_LABEL,
  reviewDetail,
  reviewList,
  routeTree,
  type SidebarDetail,
  sidebarLines,
  statusChip,
  type Tone,
  treeKey,
} from './model.js'
import { ReviewOverlay } from './review.js'
import { ReviewFlow } from './review-flow.js'
import { PANEL_EVENTS, TuiPanel } from './state.js'
import { TuiStore } from './store.js'
import { Lines, usePanel, useStore } from './view.js'

const ROUTE = 'hafiz'
/** The review overlay's default key: Kilo's defaults leave `<leader>v` free (7.8.x). */
const REVIEW_KEY = '<leader>v'

function sidebarData(snap: TuiSnapshot, store: TuiStore, sessionId: string) {
  const s = snap.sessions.get(sessionId)
  return {
    project: snap.project,
    role: s && !s.endedAt ? s.role : undefined,
    focus: s?.focus.blocks ?? [],
    nodes: snap.nodes,
    pending: snap.pending,
    notices: store.sessionNotices(sessionId),
  }
}

interface PanelState {
  detail: () => SidebarDetail
  setDetail: (d: SidebarDetail) => void
  /** Sidebar rows opened/closed by click, per Kilo session. */
  toggled: Map<string, Map<string, boolean>>
  legend: () => boolean
  setLegend: (on: boolean) => void
  /** The review overlay's key as hints show it (`ctrl+x v`). */
  reviewKey: string
  openReview: (id?: string) => void
}

function Sidebar(props: {
  api: TuiApi
  hub: TuiPanel
  panel: PanelState
  sessionId: string
  width: number
  maxRows: number
}) {
  const view = usePanel(props.hub)
  const inactive = () => {
    const k = view().kind
    return k === 'off' || k === 'untracked' ? k : undefined
  }
  return (
    <Show
      when={view().store}
      fallback={
        <Show when={inactive()}>
          {(k) => (
            <box flexShrink={0}>
              <Lines theme={props.api.theme} lines={inactiveLines(k(), props.width)} />
            </box>
          )}
        </Show>
      }
    >
      {(store) => (
        <TrackedSidebar
          api={props.api}
          store={store()}
          project={view().project?.project.worktree ?? ''}
          panel={props.panel}
          sessionId={props.sessionId}
          width={props.width}
          maxRows={props.maxRows}
        />
      )}
    </Show>
  )
}

function TrackedSidebar(props: {
  api: TuiApi
  store: TuiStore
  project: string
  panel: PanelState
  sessionId: string
  width: number
  maxRows: number
}) {
  const snap = useStore(props.store, () => props.sessionId)
  const [toggles, setToggles] = createSignal(
    props.panel.toggled.get(props.sessionId) ?? new Map<string, boolean>(),
  )
  const lines = createMemo(() => {
    const s = snap()
    if (!s) return connectingLines(basename(props.project), props.width)
    return sidebarLines(sidebarData(s, props.store, props.sessionId), {
      width: props.width,
      detail: props.panel.detail(),
      toggled: toggles(),
      maxRows: props.maxRows,
      legend: props.panel.legend(),
      reviewKey: props.panel.reviewKey,
    })
  })
  // Clicking a row with children opens or closes it (opentui delivers mouse events to boxes).
  const toggle = (id: string) => {
    const cur = lines().find((l) => l.id === id)
    const next = new Map(toggles())
    next.set(id, !cur?.expanded)
    props.panel.toggled.set(props.sessionId, next)
    setToggles(next)
  }
  return (
    <Show when={lines().length}>
      <box flexShrink={0}>
        <Lines
          theme={props.api.theme}
          lines={lines()}
          onToggle={toggle}
          onAction={(a) =>
            a === 'review' ? props.panel.openReview() : props.panel.setLegend(!props.panel.legend())
          }
        />
      </box>
    </Show>
  )
}

function Chip(props: { api: TuiApi; hub: TuiPanel; sessionId: string }) {
  const view = usePanel(props.hub)
  return (
    <Show when={view().store}>
      {(store) => <TrackedChip api={props.api} store={store()} sessionId={props.sessionId} />}
    </Show>
  )
}

function TrackedChip(props: { api: TuiApi; store: TuiStore; sessionId: string }) {
  const snap = useStore(props.store, () => props.sessionId)
  const text = createMemo(() => {
    const s = snap()
    if (!s) return ''
    return statusChip(sidebarData(s, props.store, props.sessionId))
  })
  return (
    <Show when={text()}>
      <text fg={props.api.theme.current.textMuted} wrapMode="none">
        {text()}
      </text>
    </Show>
  )
}

type Tab = 'tree' | 'review' | 'decisions' | 'notices'
const TABS: Tab[] = ['tree', 'review', 'decisions', 'notices']

function RouteView(props: {
  api: TuiApi
  store: TuiStore
  source: TuiSource
  panel: PanelState
  zooms: string[]
  params?: Record<string, unknown> | undefined
}) {
  const sessionId = () =>
    typeof props.params?.sessionID === 'string' ? (props.params.sessionID as string) : undefined
  const snap = useStore(props.store, sessionId)
  const theme = props.api.theme
  const [tab, setTab] = createSignal<Tab>('tree')
  const [toggled, setToggled] = createSignal(new Map<string, boolean>())
  const [selected, setSelected] = createSignal<string | undefined>()
  const [zoom, setZoom] = createSignal(0)
  const [history, setHistory] = createSignal(false)
  const [review, setReview] = createSignal(0)
  const [body, setBody] = createSignal<Line[]>([])
  const [cols, setCols] = createSignal(process.stdout.columns || 120)

  const focus = () => {
    const s = snap()
    const id = sessionId()
    return (s && id && s.sessions.get(id)?.focus.blocks) || []
  }
  const leftWidth = () => Math.max(24, Math.min(48, Math.floor(cols() * 0.4)))
  const rightWidth = () => Math.max(20, cols() - leftWidth() - 6)
  const tree = createMemo(() =>
    routeTree(
      snap()?.nodes ?? [],
      focus(),
      { toggled: toggled(), selected: selected() },
      leftWidth(),
    ),
  )
  const current = () => tree().rows[tree().selected]?.node.id

  // Right pane of the Tree tab: the block at the chosen zoom, or its doc history.
  let ticket = 0
  const loadBody = () => {
    const id = current()
    const n = ++ticket
    if (!id) return setBody([])
    const z = props.zooms[zoom() % props.zooms.length] ?? 'FULL'
    const work = history()
      ? props.source.history(id).then((h) => historyLines(h, rightWidth()))
      : props.source
          .blockRead(id, z)
          .then((t) => t.split('\n').map((text) => ({ text, tone: 'text' as Tone })))
    work
      .then((lines) => n === ticket && setBody(lines))
      .catch((e) => n === ticket && setBody([{ text: String(e), tone: 'error' }]))
  }
  createEffect(() => {
    current()
    zoom()
    history()
    snap()
    loadBody()
  })

  const move = (k: 'up' | 'down' | 'expand' | 'collapse') => {
    if (tab() === 'review') {
      const n = snap()?.pending.length ?? 0
      if (k === 'up') setReview((i) => Math.max(0, i - 1))
      if (k === 'down') setReview((i) => Math.min(Math.max(0, n - 1), i + 1))
      if (k === 'expand') props.panel.openReview(pending()[review()]?.id)
      return
    }
    if (tab() !== 'tree') return
    const t = tree()
    const r = treeKey(t.rows, t.selected, toggled(), k)
    setToggled(r.toggled)
    setSelected(r.selected)
  }
  const back = () => {
    const ret = props.params?.returnRoute as
      | { name?: string; params?: Record<string, unknown> }
      | undefined
    if (ret?.name) props.api.route.navigate(ret.name, ret.params)
    else if (sessionId()) props.api.route.navigate('session', { sessionID: sessionId() })
    else props.api.route.navigate('home')
  }

  onMount(() => {
    const onResize = () => setCols(process.stdout.columns || 120)
    process.stdout.on?.('resize', onResize)
    const cmd = (name: string, run: () => void) => ({ name: `hafiz.view.${name}`, run })
    const off = props.api.keymap.registerLayer({
      // off while a dialog (the review overlay) is open over the route
      enabled: () => !props.api.ui.dialog.open,
      commands: [
        cmd('up', () => move('up')),
        cmd('down', () => move('down')),
        cmd('expand', () => move('expand')),
        cmd('collapse', () => move('collapse')),
        cmd('zoom', () => setZoom((z) => z + 1)),
        cmd('history', () => setHistory((h) => !h)),
        cmd('tab', () => setTab((t) => TABS[(TABS.indexOf(t) + 1) % TABS.length] as Tab)),
        cmd('tree', () => setTab('tree')),
        cmd('review', () => setTab('review')),
        cmd('decisions', () => setTab('decisions')),
        cmd('notices', () => setTab('notices')),
        cmd('back', back),
      ],
      bindings: [
        { key: 'k,up', cmd: 'hafiz.view.up' },
        { key: 'j,down', cmd: 'hafiz.view.down' },
        { key: 'return,right,l', cmd: 'hafiz.view.expand' },
        { key: 'left', cmd: 'hafiz.view.collapse' },
        { key: 'z', cmd: 'hafiz.view.zoom' },
        { key: 'h', cmd: 'hafiz.view.history' },
        { key: 'tab', cmd: 'hafiz.view.tab' },
        { key: '1', cmd: 'hafiz.view.tree' },
        { key: '2', cmd: 'hafiz.view.review' },
        { key: '3', cmd: 'hafiz.view.decisions' },
        { key: '4', cmd: 'hafiz.view.notices' },
        { key: 'escape,q', cmd: 'hafiz.view.back' },
      ],
    })
    onCleanup(() => {
      off()
      process.stdout.off?.('resize', onResize)
    })
  })

  const titles = () => new Map((snap()?.nodes ?? []).map((n) => [n.id, n.title]))
  /** The route's Kilo session as Hafiz knows it, if Hafiz manages it. */
  const managed = () => {
    const s = sessionId() ? snap()?.sessions.get(sessionId() as string) : undefined
    return s && !s.endedAt ? s : undefined
  }
  const pending = () => snap()?.pending ?? []
  const tabLabel = (t: Tab, i: number) => (tab() === t ? `[${i + 1} ${t}]` : ` ${i + 1} ${t} `)
  const footer = () => {
    if (tab() === 'tree')
      return `↑↓ move · ⏎/→ open · ← close · z zoom (${props.zooms[zoom() % props.zooms.length] ?? 'FULL'}) · h ${history() ? 'render' : 'history'} · tab · esc back`
    if (tab() === 'review')
      return `↑↓ move · ⏎ or ${props.panel.reviewKey} review overlay: accept, reject · tab · esc back`
    if (tab() === 'notices') return 'newest first · read-only · tab · esc back'
    return 'read-only · change decisions through agents or the hafiz CLI · tab · esc back'
  }

  return (
    <box
      flexGrow={1}
      width="100%"
      height="100%"
      backgroundColor={theme.current.background}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <box flexDirection="row" flexShrink={0} gap={2}>
        <text fg={theme.current.text} wrapMode="none">
          <b>Hafiz · {snap()?.project ?? '…'}</b>
        </text>
        <text fg={theme.current.accent} wrapMode="none">
          {TABS.map(tabLabel).join(' ')}
        </text>
        <Show when={props.store.error && !snap()}>
          <text fg={theme.current.warning} wrapMode="none">
            daemon not reachable
          </text>
        </Show>
      </box>
      <box flexGrow={1} flexDirection="row" paddingTop={1} gap={2} minHeight={0}>
        <Show when={tab() === 'tree'}>
          <scrollbox width={leftWidth()} flexShrink={0}>
            <Lines
              theme={theme}
              lines={tree().lines}
              onToggle={(id) => {
                setSelected(id)
                const row = tree().lines.find((l) => l.id === id)
                if (row) setToggled(new Map(toggled()).set(id, !row.expanded))
              }}
            />
          </scrollbox>
          <scrollbox flexGrow={1}>
            <Lines theme={theme} lines={body()} />
          </scrollbox>
        </Show>
        <Show when={tab() === 'review'}>
          <scrollbox width={leftWidth()} flexShrink={0}>
            <Lines theme={theme} lines={reviewList(pending(), review(), leftWidth())} />
          </scrollbox>
          <scrollbox flexGrow={1}>
            <Lines
              theme={theme}
              lines={reviewDetail(
                pending()[review()],
                titles(),
                rightWidth(),
                props.panel.reviewKey,
              )}
            />
          </scrollbox>
        </Show>
        <Show when={tab() === 'decisions'}>
          <scrollbox flexGrow={1}>
            <Lines
              theme={theme}
              lines={decisionLines(snap()?.standing ?? [], snap()?.nodes ?? [], cols() - 6)}
            />
          </scrollbox>
        </Show>
        <Show when={tab() === 'notices'}>
          <scrollbox flexGrow={1}>
            <Lines
              theme={theme}
              lines={noticeLines(
                props.store.sessionNotices(sessionId()),
                cols() - 6,
                managed()?.counters,
              )}
            />
          </scrollbox>
        </Show>
      </box>
      <box flexShrink={0} paddingBottom={1}>
        <text fg={theme.current.textMuted} wrapMode="none">
          {footer()}
        </text>
      </box>
    </box>
  )
}

/** `/hafiz` without a Hafiz project: the same message as the sidebar. */
function InactiveRoute(props: {
  api: TuiApi
  kind: 'off' | 'untracked'
  params?: Record<string, unknown> | undefined
}) {
  const theme = props.api.theme
  onMount(() => {
    const back = () => {
      const ret = props.params?.returnRoute as
        | { name?: string; params?: Record<string, unknown> }
        | undefined
      if (ret?.name) props.api.route.navigate(ret.name, ret.params)
      else props.api.route.navigate('home')
    }
    const off = props.api.keymap.registerLayer({
      commands: [{ name: 'hafiz.view.back', run: back }],
      bindings: [{ key: 'escape,q', cmd: 'hafiz.view.back' }],
    })
    onCleanup(off)
  })
  return (
    <box
      flexGrow={1}
      width="100%"
      height="100%"
      backgroundColor={theme.current.background}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
    >
      <Lines theme={theme} lines={inactiveLines(props.kind, 200)} />
      <box flexGrow={1} />
      <box flexShrink={0} paddingBottom={1}>
        <text fg={theme.current.textMuted} wrapMode="none">
          esc back
        </text>
      </box>
    </box>
  )
}

function Route(props: {
  api: TuiApi
  hub: TuiPanel
  panel: PanelState
  source: () => TuiSource | undefined
  params?: Record<string, unknown> | undefined
}) {
  const view = usePanel(props.hub)
  return (
    <Show
      when={view().store && props.source()}
      fallback={
        <InactiveRoute
          api={props.api}
          kind={view().kind === 'off' ? 'off' : 'untracked'}
          params={props.params}
        />
      }
    >
      <RouteView
        api={props.api}
        store={view().store as TuiStore}
        source={props.source() as TuiSource}
        panel={props.panel}
        zooms={view().project?.zooms ?? []}
        params={props.params}
      />
    </Show>
  )
}

const num = (v: unknown, d: number) => (typeof v === 'number' && v > 0 ? v : d)

/** A key binding as Kilo's own hints print it (`<leader>v` -> `ctrl+x v`), else a fallback. */
function keyLabel(api: TuiApi, key: string, fallback: string): string {
  try {
    const parts = api.keymap.parseKeySequence?.(key)
    const label = parts && api.keys?.formatSequence(Array.from(parts))
    return label || fallback
  } catch {
    return fallback
  }
}

const tui: TuiPlugin = async (api, options) => {
  const dir = api.state.path.directory || process.cwd()
  const locate = projectLocator(dir, process.env) // resolves the git dir once
  const currentSession = () => {
    const r = api.route.current
    const id = r.params?.sessionID
    return typeof id === 'string' ? id : undefined
  }
  const reviewBinding =
    typeof options?.review_keybind === 'string' ? options.review_keybind : REVIEW_KEY
  const reviewKey =
    reviewBinding === REVIEW_KEY
      ? keyLabel(api, reviewBinding, REVIEW_KEY_LABEL)
      : keyLabel(api, reviewBinding, reviewBinding)
  let source: TuiSource | undefined
  const hub = new TuiPanel({
    locate,
    open: ({ project }) => {
      source = new TuiSource({ project })
      return new TuiStore(source, {
        current: currentSession,
        toast: (t) => api.ui.toast({ ...t, duration: 5000 }),
        reviewHint: `${reviewKey} review`,
      })
    },
  })
  // The review overlay: Kilo dialogs over whatever is on screen, drawn from the live store.
  const flow: ReviewFlow<ReturnType<typeof ReviewOverlay>> = new ReviewFlow({
    dialog: api.ui.dialog,
    render: (view) => (
      <ReviewOverlay
        api={api}
        store={hub.store as TuiStore}
        source={source as TuiSource}
        flow={flow}
        view={view}
      />
    ),
    toast: (t) => api.ui.toast({ ...t, duration: 4000 }),
    source: {
      accept: (id) => (source ? source.accept(id) : Promise.reject(new Error('not tracked'))),
      reject: (id, note) =>
        source ? source.reject(id, note) : Promise.reject(new Error('not tracked')),
    },
    refresh: () => hub.store?.refresh(),
  })
  /** Open the overlay: the list, or one item's detail. */
  const openReview = (id?: string) => {
    if (!hub.store?.snapshot || !source) {
      api.ui.toast({
        variant: 'info',
        message:
          hub.kind === 'connecting' ? 'Hafiz: daemon not reachable yet' : 'Hafiz: not tracked here',
        duration: 2500,
      })
      return
    }
    const item = id ? hub.store.snapshot.pending.find((p) => p.id === id) : undefined
    flow.open(item ? { kind: 'detail', item } : { kind: 'list' })
  }
  const [detail, setDetail] = createSignal<SidebarDetail>('active')
  const [legend, setLegend] = createSignal(false)
  const panel: PanelState = {
    detail,
    setDetail,
    toggled: new Map(),
    legend,
    setLegend,
    reviewKey,
    openReview,
  }
  const width = num(options?.width, 36)
  const maxRows = num(options?.max_rows, 14)

  api.slots.register({
    order: 120,
    slots: {
      sidebar_content: (_ctx, props) => (
        <Sidebar
          api={api}
          hub={hub}
          panel={panel}
          sessionId={props.session_id}
          width={width}
          maxRows={maxRows}
        />
      ),
      session_prompt_right: (_ctx, props) => (
        <Chip api={api} hub={hub} sessionId={props.session_id} />
      ),
    },
  })
  api.route.register([
    {
      name: ROUTE,
      render: (input) => (
        <Route api={api} hub={hub} panel={panel} source={() => source} params={input.params} />
      ),
    },
  ])
  const open = () => {
    api.route.navigate(ROUTE, {
      ...(currentSession() ? { sessionID: currentSession() } : {}),
      returnRoute: api.route.current,
    })
    api.ui.dialog.clear()
  }
  const offKeys = api.keymap.registerLayer({
    commands: [
      {
        name: 'hafiz.open',
        title: 'Hafiz: block tree, review queue, decisions',
        category: 'Hafiz',
        namespace: 'palette',
        slashName: 'hafiz',
        run: open,
      },
      {
        name: 'hafiz.review.open',
        title: 'Hafiz: review queue (accept, reject)',
        category: 'Hafiz',
        namespace: 'palette',
        slashName: 'hafiz-review',
        run: () => openReview(),
      },
      {
        name: 'hafiz.sidebar.legend',
        title: 'Hafiz: toggle the sidebar glyph legend',
        category: 'Hafiz',
        namespace: 'palette',
        run: () => setLegend(!legend()),
      },
      {
        name: 'hafiz.sidebar.detail',
        title: 'Hafiz: cycle sidebar detail (active / full / focus path)',
        category: 'Hafiz',
        namespace: 'palette',
        run: () => {
          setDetail(nextDetail(detail()))
          panel.toggled.clear()
          api.ui.toast({ variant: 'info', message: `Hafiz sidebar: ${detail()}`, duration: 1500 })
        },
      },
    ],
    bindings: [
      {
        key: typeof options?.keybind === 'string' ? options.keybind : '<leader>f',
        cmd: 'hafiz.open',
      },
      { key: reviewBinding, cmd: 'hafiz.review.open' },
    ],
  })
  // Kilo's event stream drives every state change: a completed first block create starts the tracked
  // panel, other events refresh it. There is no timer.
  const offs = PANEL_EVENTS.map((type) => api.event.on(type, (e) => hub.onEvent(e)))
  api.lifecycle.onDispose(() => {
    offKeys()
    for (const off of offs) off()
    hub.dispose()
    source?.close()
  })
}

const plugin: { id: string; tui: TuiPlugin } = { id: 'hafiz', tui }
export default plugin
