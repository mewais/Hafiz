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
  /** `palette` lists the command in the command palette (and its slash name in `/` completion). */
  namespace?: string
  /** Typed as `/<slashName>` in the prompt; one word (completion matches the display). */
  slashName?: string
  slashAliases?: string[]
  run(): void
}

export interface TuiKeyLayer {
  /**
   * Higher wins; equal priorities: the later layer wins. Kilo's open-dialog layer (escape,
   * ctrl+c) has 0, its prompt dialog's submit 1.
   */
  priority?: number
  /** Checked when a key arrives; a disabled layer neither runs nor swallows its keys. */
  enabled?: boolean | (() => boolean)
  bindings?: Array<{ key: string; cmd: string; desc?: string }>
  commands?: TuiKeyCommand[]
}

export type DialogSize = 'medium' | 'large' | 'xlarge'

/**
 * Kilo's dialog stack. `replace` closes what is open (calling its onClose) and shows `render`,
 * whose element is inserted reactively: signals read inside stay live. Kilo wraps it in its own
 * dialog frame (backdrop, width by size), so the element is the content; `replace` resets the
 * size to medium, so set it after. Escape and ctrl+c close the top dialog (its onClose, then pop).
 */
export interface TuiDialogStack {
  replace(render: () => JSX.Element, onClose?: () => void): void
  clear(): void
  setSize(size: DialogSize): void
  readonly size: DialogSize
  readonly depth: number
  readonly open: boolean
}

export interface TuiDialogPromptProps {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  /** ⏎ (Kilo's `dialog.prompt.submit`); the textarea's plain text. */
  onConfirm?: (value: string) => void
  /** Not called by escape: escape closes the dialog through the stack's onClose. */
  onCancel?: () => void
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
    dialog: TuiDialogStack
    /** A text prompt; mounted inside `dialog.replace`. Sets the dialog size to medium. */
    DialogPrompt(props: TuiDialogPromptProps): JSX.Element
  }
  keymap: {
    registerLayer(layer: TuiKeyLayer): () => void
    parseKeySequence?(key: string): Iterable<unknown>
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
  /** Formats a parsed key sequence for display (`ctrl+x v`); how Kilo's own hints do it. */
  keys?: { formatSequence(parts: readonly unknown[] | undefined): string }
  theme: TuiTheme
  lifecycle: { readonly signal: AbortSignal; onDispose(fn: () => void | Promise<void>): () => void }
}

export type TuiPlugin = (api: TuiApi, options: Record<string, unknown> | undefined) => Promise<void>
