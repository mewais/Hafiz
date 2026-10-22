// The review overlay's navigation and writes, framework-free (review.tsx draws the three views).
// List -> detail -> reject prompt, each shown with Kilo's `dialog.replace`; esc steps back one
// view. Kilo's dialog stack calls a dialog's onClose both when it is replaced and when escape
// closes it, so `open` marks its own replacements and only an onClose it did not cause counts
// as escape (the view's own escape binding normally gets there first; this is the fallback).
// Accept and reject go through the source as the `user` role; a daemon error is a toast and the
// overlay stays where it was.
import type { ReviewRow } from './model.js'
import { acceptedToast, rejectedToast } from './model.js'

export type ReviewView =
  | { kind: 'list'; selected?: string | undefined }
  | { kind: 'detail'; item: ReviewRow }
  | { kind: 'reject'; item: ReviewRow }

export interface ReviewFlowDeps<E> {
  dialog: {
    replace(render: () => E, onClose?: () => void): void
    clear(): void
  }
  render: (view: ReviewView) => E
  toast: (t: { variant: 'success' | 'error'; title: string; message: string }) => void
  source: {
    accept(id: string): Promise<unknown>
    reject(id: string, note?: string): Promise<unknown>
  }
  /** Re-read the store once a write went through, so the list redraws without the item. */
  refresh: () => unknown
  /** Defers the escape fallback until Kilo's escape handler has popped the closed dialog. */
  defer?: (fn: () => void) => void
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class ReviewFlow<E> {
  /** What is on screen; undefined when the overlay is closed. */
  view: ReviewView | undefined
  private replacing = false

  constructor(private readonly deps: ReviewFlowDeps<E>) {}

  open(view: ReviewView = { kind: 'list' }): void {
    this.replacing = true
    try {
      this.deps.dialog.replace(
        () => this.deps.render(view),
        () => this.closed(view),
      )
    } finally {
      this.replacing = false
    }
    this.view = view
  }

  /** esc: reject prompt -> detail -> list -> closed. */
  back(): void {
    const v = this.view
    if (!v) return
    if (v.kind === 'reject') this.open({ kind: 'detail', item: v.item })
    else if (v.kind === 'detail') this.open({ kind: 'list', selected: v.item.id })
    else this.close()
  }

  close(): void {
    this.replacing = true
    try {
      this.deps.dialog.clear()
    } finally {
      this.replacing = false
    }
    this.view = undefined
  }

  /** Kilo closed a view (escape, ctrl+c, a click outside, or our own replace/clear). */
  private closed(view: ReviewView): void {
    if (this.replacing || this.view !== view) return
    this.view = undefined
    if (view.kind === 'list') return
    const defer = this.deps.defer ?? queueMicrotask
    this.view = view // until the deferred step lands, `back` still knows where it was
    defer(() => {
      if (this.view === view) this.back()
    })
  }

  async accept(item: ReviewRow): Promise<boolean> {
    try {
      await this.deps.source.accept(item.id)
    } catch (e) {
      this.deps.toast({ variant: 'error', title: 'Hafiz review', message: errorText(e) })
      return false
    }
    this.deps.toast({ variant: 'success', title: 'Hafiz review', message: acceptedToast(item) })
    await this.deps.refresh()
    if (this.view?.kind === 'detail' && this.view.item.id === item.id) this.open({ kind: 'list' })
    return true
  }

  async reject(item: ReviewRow, note: string): Promise<boolean> {
    const why = note.trim()
    try {
      await this.deps.source.reject(item.id, why || undefined)
    } catch (e) {
      this.deps.toast({ variant: 'error', title: 'Hafiz review', message: errorText(e) })
      return false
    }
    this.deps.toast({ variant: 'success', title: 'Hafiz review', message: rejectedToast(item) })
    await this.deps.refresh()
    if (this.view && this.view.kind !== 'list') this.open({ kind: 'list' })
    return true
  }
}
