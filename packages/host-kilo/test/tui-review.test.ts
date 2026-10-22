// The review overlay's navigation and writes (ReviewFlow) against a fake of Kilo's dialog stack
// that behaves like Kilo 7.8's: `replace` calls the open dialog's onClose, escape calls it and
// then pops, `clear` calls every onClose and empties the stack.
import type { ReviewItem } from '@hafiz/core'
import { describe, expect, it } from 'vitest'
import { ReviewFlow, type ReviewView } from '../src/tui/review-flow.js'

function kiloDialog() {
  let stack: Array<{ element: () => string; onClose?: (() => void) | undefined }> = []
  return {
    replace(render: () => string, onClose?: () => void) {
      for (const d of stack) d.onClose?.()
      stack = [{ element: render, onClose }]
    },
    clear() {
      for (const d of stack) d.onClose?.()
      stack = []
    },
    escape() {
      stack.at(-1)?.onClose?.()
      stack = stack.slice(0, -1)
    },
    get shown() {
      return stack.at(-1)?.element()
    },
  }
}

const item = (id: string, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id,
  kind: 'design',
  source: 'review',
  blockId: 'orders',
  blockTitle: 'Orders',
  version: 2,
  mode: 'gate',
  payload: { command: 'review.approve', args: {} },
  status: 'pending',
  createdAt: '2026-10-22T09:00:00Z',
  ...over,
})

function setup(fail?: string) {
  const dialog = kiloDialog()
  const toasts: string[] = []
  const calls: string[] = []
  let refreshes = 0
  const deferred: Array<() => void> = []
  const flow: ReviewFlow<string> = new ReviewFlow<string>({
    dialog,
    render: (v: ReviewView) =>
      v.kind === 'list' ? `list ${v.selected ?? ''}`.trim() : `${v.kind} ${v.item.id}`,
    toast: (t) => toasts.push(`${t.variant}: ${t.message}`),
    source: {
      accept: async (id) => {
        calls.push(`accept ${id}`)
        if (fail) throw new Error(fail)
      },
      reject: async (id, note) => {
        calls.push(`reject ${id} ${note ?? '-'}`)
        if (fail) throw new Error(fail)
      },
    },
    refresh: () => {
      refreshes++
    },
    defer: (fn) => deferred.push(fn),
  })
  const flush = () => {
    for (const fn of deferred.splice(0)) fn()
  }
  return { dialog, flow, toasts, calls, flush, refreshes: () => refreshes }
}

describe('review overlay flow', () => {
  it('list -> detail -> reject and back with its own esc; replacing never steps back', () => {
    const { dialog, flow } = setup()
    flow.open()
    expect(dialog.shown).toBe('list')
    flow.open({ kind: 'detail', item: item('p1') })
    expect(dialog.shown).toBe('detail p1')
    flow.open({ kind: 'reject', item: item('p1') })
    expect(dialog.shown).toBe('reject p1')
    flow.back()
    expect(dialog.shown).toBe('detail p1')
    flow.back()
    expect(dialog.shown).toBe('list p1') // the list keeps the selection
    flow.back()
    expect(dialog.shown).toBeUndefined()
    expect(flow.view).toBeUndefined()
  })

  it("Kilo's own escape (fallback) also steps back one view, once it has popped", () => {
    const { dialog, flow, flush } = setup()
    flow.open({ kind: 'reject', item: item('p1') })
    dialog.escape()
    expect(dialog.shown).toBeUndefined()
    flush()
    expect(dialog.shown).toBe('detail p1')
    dialog.escape()
    flush()
    expect(dialog.shown).toBe('list p1')
    dialog.escape()
    flush()
    expect(dialog.shown).toBeUndefined()
    expect(flow.view).toBeUndefined()
  })

  it('accept as the user: toast, refresh, back to the list from the detail', async () => {
    const { dialog, flow, toasts, calls, refreshes } = setup()
    flow.open({ kind: 'detail', item: item('p1') })
    expect(await flow.accept(item('p1'))).toBe(true)
    expect(calls).toEqual(['accept p1'])
    expect(toasts).toEqual(['success: design Orders v2 accepted · planner may start'])
    expect(refreshes()).toBe(1)
    expect(dialog.shown).toBe('list')
  })

  it('reject with a note (blank: none), then the list', async () => {
    const { dialog, flow, toasts, calls } = setup()
    flow.open({ kind: 'reject', item: item('p1') })
    await flow.reject(item('p1'), '  say who refunds \n')
    await flow.reject(item('p2', { mode: 'queue' }), '   ')
    expect(calls).toEqual(['reject p1 say who refunds', 'reject p2 -'])
    expect(toasts[0]).toBe('success: design Orders v2 rejected')
    expect(dialog.shown).toBe('list')
  })

  it('daemon errors are an error toast; the overlay stays where it was', async () => {
    const { dialog, flow, toasts, refreshes } = setup("forbidden: role 'manager' may not")
    flow.open({ kind: 'reject', item: item('p1') })
    expect(await flow.reject(item('p1'), 'no')).toBe(false)
    expect(await flow.accept(item('p1'))).toBe(false)
    expect(toasts).toEqual([
      "error: forbidden: role 'manager' may not",
      "error: forbidden: role 'manager' may not",
    ])
    expect(refreshes()).toBe(0)
    expect(dialog.shown).toBe('reject p1')
  })
})
