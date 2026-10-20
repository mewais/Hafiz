// The slice of Kilo's TUI plugin API (`@kilocode/plugin/tui` 7.8.x) the panel uses, typed
// structurally like ../kilo.ts so the package needs no dependency on Kilo. Verified against the
// installed `tui.d.ts` and Kilo's TUI plugin runtime (see docs/HOST-MATRIX.md §3.3).
import type { JSX } from '@opentui/solid'

/** Theme colours are RGBA objects; the panel only passes them through to `fg`. */
// biome-ignore lint/suspicious/noExplicitAny: opaque RGBA from @opentui/core
export type Colour = any

export interface TuiTheme {
  readonly current: {
    readonly text: Colour
    readonly textMuted: Colour
    readonly primary: Colour
    readonly accent: Colour
    readonly success: Colour
    readonly warning: Colour
    readonly error: Colour
    readonly backgroundPanel: Colour
    readonly background: Colour
    readonly border: Colour
  }
}

export type TuiRoute = { name: string; params?: Record<string, unknown> }

export interface TuiKeyCommand {
  name: string
  title?: string
  desc?: string
  category?: string
  namespace?: string
  slashName?: string
  run(): void
}

export interface TuiApi {
  route: {
    register(
      routes: Array<{
        name: string
        render(input: { params?: Record<string, unknown> }): JSX.Element
      }>,
    ): () => void
    navigate(name: string, params?: Record<string, unknown>): void
    readonly current: TuiRoute
  }
  ui: {
    toast(input: {
      variant?: 'info' | 'success' | 'warning' | 'error'
      title?: string
      message: string
      duration?: number
    }): void
    dialog: { clear(): void }
  }
  keymap: {
    registerLayer(layer: {
      priority?: number
      bindings?: Array<{ key: string; cmd: string; desc?: string }>
      commands?: TuiKeyCommand[]
    }): () => void
  }
  slots: {
    register(plugin: {
      order?: number
      slots: Record<string, (ctx: unknown, props: { session_id: string }) => JSX.Element>
    }): string
  }
  event: {
    on(
      type: string,
      handler: (event: { type: string; properties?: Record<string, unknown> }) => void,
    ): () => void
  }
  state: { readonly path: { directory: string } }
  theme: TuiTheme
  lifecycle: { readonly signal: AbortSignal; onDispose(fn: () => void | Promise<void>): () => void }
}

export type TuiPlugin = (api: TuiApi, options: Record<string, unknown> | undefined) => Promise<void>
