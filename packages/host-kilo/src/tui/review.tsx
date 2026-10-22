// The review overlay: three Kilo dialogs over whatever is on screen. The list (size large) reads
// the store's review queue, so it redraws whenever the store does (an accept here, or any Kilo
// event that refreshes it); the detail (xlarge) shows `review.show` for one item; the reject
// prompt is Kilo's DialogPrompt. Each view registers its keys in a keymap layer only while it is
// mounted, at a priority above Kilo's dialog layer, so `a`/`r` never reach a text field and esc
// steps back instead of closing everything. Navigation and writes live in ReviewFlow.
import type { ReviewShow } from '@hafiz/core'
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { TuiSource } from './data.js'
import type { DialogSize, TuiApi } from './kilo-tui.js'
import {
  type Line,
  REJECT_HINT,
  type ReviewRow,
  rejectTitle,
  reviewDetailBody,
  reviewDetailFooter,
  reviewDetailMeta,
  reviewDetailTitle,
  reviewOverlayFooter,
  reviewOverlayRows,
  reviewOverlayTitle,
} from './model.js'
import type { ReviewFlow, ReviewView } from './review-flow.js'
import type { TuiStore } from './store.js'
import { Lines, useStore, useTerminal } from './view.js'

// biome-ignore lint/suspicious/noExplicitAny: Solid's JSX.Element
type Flow = ReviewFlow<any>

export interface ReviewDeps {
  api: TuiApi
  store: TuiStore
  source: TuiSource
  flow: Flow
}

/** Kilo's dialog frame widths (its `Dialog` component), less our 2+2 padding. */
const WIDTH: Record<DialogSize, number> = { medium: 60, large: 88, xlarge: 116 }
const contentWidth = (size: DialogSize, cols: number) => Math.min(WIDTH[size], cols - 2) - 4

/** Keys of a view, live while it is mounted; above Kilo's dialog layer (priority 0). */
function useKeys(api: TuiApi, keys: Record<string, [string, () => void]>, priority = 1) {
  onMount(() => {
    const entries = Object.entries(keys)
    const off = api.keymap.registerLayer({
      priority,
      commands: entries.map(([name, [, run]]) => ({ name: `hafiz.review.${name}`, run })),
      bindings: entries.map(([name, [key]]) => ({ key, cmd: `hafiz.review.${name}` })),
    })
    onCleanup(off)
  })
}

function Header(props: { api: TuiApi; title: string; onClose: () => void }) {
  const t = props.api.theme.current
  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <text fg={t.text} wrapMode="none">
        <b>{props.title}</b>
      </text>
      <text fg={t.textMuted} onMouseUp={props.onClose}>
        esc
      </text>
    </box>
  )
}

export function ReviewOverlay(props: ReviewDeps & { view: ReviewView }) {
  const v = props.view
  if (v.kind === 'detail') return <ReviewDetail {...props} item={v.item} />
  if (v.kind === 'reject') return <ReviewReject {...props} item={v.item} />
  return <ReviewList {...props} selected={v.selected} />
}

function ReviewList(props: ReviewDeps & { selected?: string | undefined }) {
  const snap = useStore(props.store)
  const term = useTerminal()
  const items = (): ReviewRow[] => snap()?.pending ?? []
  const [pick, setPick] = createSignal(props.selected)
  // the selection follows its item when the list changes; a resolved item hands it to the next
  const at = createMemo<number>((prev) => {
    const list = items()
    const i = list.findIndex((p) => p.id === pick())
    return i >= 0 ? i : Math.min(prev, Math.max(0, list.length - 1))
  }, 0)
  const current = () => items()[at()]
  const move = (d: number) => {
    const list = items()
    const next = list[Math.max(0, Math.min(list.length - 1, at() + d))]
    if (next) setPick(next.id)
  }
  const detail = () => {
    const p = current()
    if (p) props.flow.open({ kind: 'detail', item: p })
  }
  const width = () => contentWidth('large', term().cols)
  const rows = createMemo(() => reviewOverlayRows(items(), at(), width(), Date.now()))
  onMount(() => props.api.ui.dialog.setSize('large'))
  useKeys(props.api, {
    up: ['up,k', () => move(-1)],
    down: ['down,j', () => move(1)],
    open: ['return', detail],
    accept: ['a', () => current() && void props.flow.accept(current() as ReviewRow)],
    reject: [
      'r',
      () => current() && props.flow.open({ kind: 'reject', item: current() as ReviewRow }),
    ],
    close: ['escape', () => props.flow.close()],
  })
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <Header
        api={props.api}
        title={reviewOverlayTitle(items().length)}
        onClose={() => props.flow.close()}
      />
      <scrollbox height={Math.max(1, Math.min(rows().length, term().rows - 14))}>
        <Lines
          theme={props.api.theme}
          lines={rows()}
          onPick={(id) => {
            setPick(id)
            detail()
          }}
        />
      </scrollbox>
      <box flexShrink={0}>
        <Lines theme={props.api.theme} lines={reviewOverlayFooter(current(), width())} />
      </box>
    </box>
  )
}

function ReviewDetail(props: ReviewDeps & { item: ReviewRow }) {
  const snap = useStore(props.store)
  const term = useTerminal()
  const [shown, setShown] = createSignal<ReviewShow | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const [previous, setPrevious] = createSignal(false)
  let scroll: { scrollBy(delta: number): void } | undefined
  // Re-read whenever the store changes: a newer version may have replaced this one.
  let ticket = 0
  createEffect(() => {
    snap()
    const n = ++ticket
    props.source
      .reviewShow(props.item.id)
      .then((s) => {
        if (n !== ticket) return
        setShown(s)
        setError(undefined)
      })
      .catch((e) => n === ticket && setError(e instanceof Error ? e.message : String(e)))
  })
  const item = (): ReviewRow => shown()?.item ?? props.item
  const node = () =>
    item().blockId ? snap()?.nodes.find((x) => x.id === item().blockId) : undefined
  const width = () => contentWidth('xlarge', term().cols)
  const body = createMemo((): Line[] => {
    const s = shown()
    if (!s) return [{ text: error() ?? 'loading…', tone: error() ? 'error' : 'muted' }]
    return reviewDetailBody(s, node(), width(), previous())
  })
  const pending = () => !shown() || shown()?.item.status === 'pending'
  onMount(() => props.api.ui.dialog.setSize('xlarge'))
  useKeys(props.api, {
    up: ['up,k', () => scroll?.scrollBy(-1)],
    down: ['down,j', () => scroll?.scrollBy(1)],
    pageup: ['pageup', () => scroll?.scrollBy(-10)],
    pagedown: ['pagedown', () => scroll?.scrollBy(10)],
    previous: ['d', () => setPrevious((p) => !p)],
    accept: ['a', () => pending() && void props.flow.accept(item())],
    reject: ['r', () => pending() && props.flow.open({ kind: 'reject', item: item() })],
    back: ['escape', () => props.flow.back()],
  })
  const t = props.api.theme.current
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <Header api={props.api} title={reviewDetailTitle(item())} onClose={() => props.flow.back()} />
      <Show when={shown()}>
        {(s) => (
          <text fg={t.textMuted} wrapMode="none">
            {reviewDetailMeta(s(), Date.now())}
          </text>
        )}
      </Show>
      <scrollbox
        ref={(r: { scrollBy(delta: number): void }) => {
          scroll = r
        }}
        height={Math.max(3, Math.min(body().length, term().rows - 14))}
      >
        <Lines theme={props.api.theme} lines={body()} />
      </scrollbox>
      <text fg={t.textMuted} wrapMode="none">
        {pending() ? reviewDetailFooter(previous()) : `${shown()?.item.status} · esc back`}
      </text>
    </box>
  )
}

function ReviewReject(props: ReviewDeps & { item: ReviewRow }) {
  const [busy, setBusy] = createSignal(false)
  // Above the prompt's own submit layer (1): esc returns to the detail, not out of the overlay.
  useKeys(props.api, { cancel: ['escape', () => props.flow.back()] }, 2)
  const muted = props.api.theme.current.textMuted
  const Prompt = props.api.ui.DialogPrompt
  return (
    <Prompt
      title={rejectTitle(props.item)}
      description={() => <text fg={muted}>{REJECT_HINT}</text>}
      placeholder="what should change"
      busy={busy()}
      busyText="rejecting…"
      onConfirm={(note) => {
        setBusy(true)
        void props.flow.reject(props.item, note).then(() => setBusy(false))
      }}
      onCancel={() => props.flow.back()}
    />
  )
}
