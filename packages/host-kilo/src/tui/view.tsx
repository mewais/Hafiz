// Solid helpers the panel's views share: theme colours for model tones, the bridges from the
// plain-JS store and panel to Solid signals, and a list of model lines.
import { createSignal, For, onCleanup, onMount } from 'solid-js'
import type { Colour, TuiTheme } from './kilo-tui.js'
import type { Line, Tone } from './model.js'
import type { TuiPanel } from './state.js'
import type { TuiStore } from './store.js'

export function colour(theme: TuiTheme, tone: Tone): Colour {
  const t = theme.current
  switch (tone) {
    case 'title':
      return t.text
    case 'muted':
      return t.textMuted
    case 'accent':
      return t.accent
    case 'success':
      return t.success
    case 'warning':
      return t.warning
    case 'error':
      return t.error
    default:
      return t.text
  }
}

/** Re-render on every store change (the store is plain JS; this is the bridge to Solid). */
export function useStore(store: TuiStore, sessionId?: () => string | undefined) {
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const off = store.subscribe(() => setTick((n) => n + 1))
    const release = store.watch(sessionId?.())
    onCleanup(() => {
      off()
      release()
    })
  })
  return () => {
    tick()
    return store.snapshot
  }
}

/** Re-render when the panel switches state (untracked -> tracked, daemon reached). */
export function usePanel(panel: TuiPanel) {
  const [tick, setTick] = createSignal(0)
  onMount(() => {
    const off = panel.subscribe(() => setTick((n) => n + 1))
    onCleanup(off)
  })
  return () => {
    tick()
    return panel
  }
}

/** Model lines, coloured; a click goes to the row's toggle, action or id. */
export function Lines(props: {
  theme: TuiTheme
  lines: Line[]
  onToggle?: (id: string) => void
  onAction?: (action: NonNullable<Line['action']>) => void
  onPick?: (id: string) => void
}) {
  return (
    <For each={props.lines}>
      {(l) => (
        <box
          flexShrink={0}
          onMouseDown={() => {
            if (l.toggle && l.id) props.onToggle?.(l.id)
            else if (l.action) props.onAction?.(l.action)
            else if (l.id) props.onPick?.(l.id)
          }}
        >
          <text fg={colour(props.theme, l.tone)} wrapMode="none">
            {l.tone === 'title' ? <b>{l.text}</b> : l.text}
          </text>
        </box>
      )}
    </For>
  )
}

/** Terminal size, updated on resize (an event, not a timer). */
export function useTerminal() {
  const size = () => ({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 40 })
  const [term, setTerm] = createSignal(size())
  onMount(() => {
    const onResize = () => setTerm(size())
    process.stdout.on?.('resize', onResize)
    onCleanup(() => process.stdout.off?.('resize', onResize))
  })
  return term
}
