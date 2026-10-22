// Golden text for the TUI panel's view models: what the sidebar, the status chip and the /hafiz
// route draw is decided here (the Solid components only colour these lines).
import type { Proposal, ReviewItem } from '@hafiz/core'
import { describe, expect, it } from 'vitest'
import {
  acceptedToast,
  connectingLines,
  costLine,
  decisionLines,
  flatten,
  footerLine,
  glyph,
  inactiveLines,
  indexTree,
  nextDetail,
  noticeLines,
  noticeWrap,
  REJECT_HINT,
  rejectedToast,
  rejectTitle,
  reviewDetail,
  reviewDetailBody,
  reviewDetailFooter,
  reviewDetailMeta,
  reviewDetailTitle,
  reviewList,
  reviewMark,
  reviewOverlayFooter,
  reviewOverlayRows,
  reviewOverlayTitle,
  reviewSummary,
  routeTree,
  type SidebarData,
  sidebarLines,
  statusChip,
  type TuiNode,
  treeKey,
} from '../src/tui/model.js'

let order = 0
function node(
  id: string,
  parentId: string | null,
  title: string,
  status: TuiNode['status'],
  extra: Partial<TuiNode> = {},
): TuiNode {
  return {
    id,
    parentId,
    title,
    kind: 'component',
    status,
    order: order++,
    depth: 0,
    docs: { design: 0, plan: 0, digest: 0 },
    threads: [],
    decisions: 0,
    recentDecisions: [],
    ...extra,
  }
}

function review(
  id: string,
  kind: Proposal['kind'],
  source: Proposal['source'],
  blockId: string | undefined,
  blockTitle: string | undefined,
  extra: Partial<ReviewItem> = {},
): ReviewItem {
  return {
    id,
    kind,
    source,
    ...(blockId ? { blockId } : {}),
    ...(blockTitle ? { blockTitle } : {}),
    payload: { command: 'review.approve', args: {} },
    note: `${kind} note`,
    status: 'pending',
    createdAt: '2026-10-21T10:00:00Z',
    mode: 'queue',
    ...extra,
  }
}

const decision = (id: string, blockId: string, title: string, standing?: 'never' | 'always') => ({
  id,
  blockId,
  title,
  decision: `${title} decided.`,
  ts: '2026-10-01T10:00:00Z',
  ...(standing ? { standing } : {}),
})

// The mock from the design: a shop with billing in progress.
const SHOP: TuiNode[] = [
  node('root', null, 'Shop', 'active'),
  node('auth', 'root', 'Auth', 'done'),
  node('billing', 'root', 'Billing', 'active', {
    decisions: 4,
    recentDecisions: [decision('d2', 'billing', 'Cents'), decision('d1', 'billing', 'Stripe')],
  }),
  node('invoices', 'billing', 'Invoices', 'done'),
  node('pdf', 'invoices', 'PDF export', 'done'),
  node('email', 'invoices', 'Email', 'done'),
  node('payments', 'billing', 'Payments', 'active', {
    steps: { done: 3, total: 5 },
    threads: [
      { id: 't1', title: 'retry semantics', status: 'open' },
      { id: 't2', title: 'refund window', status: 'parked' },
    ],
  }),
  node('reporting', 'root', 'Reporting', 'planned', {
    threads: [{ id: 't3', title: 'export formats', status: 'parked' }],
  }),
  node('search', 'root', 'Search', 'blocked', { blockedOn: { kind: 'user' } }),
]

const data = (over: Partial<SidebarData> = {}): SidebarData => ({
  project: 'shop',
  role: 'manager',
  focus: ['payments', 'reporting'],
  nodes: SHOP,
  pending: [
    review('prop_d', 'design', 'review', 'payments', 'Payments', { version: 2, mode: 'gate' }),
    review('prop_s', 'status', 'auto_done', 'auth', 'Auth', { mode: 'gate' }),
  ],
  notices: [
    { level: 'info', event: 'proposal', text: 'proposal prop_1 pending review' },
    { level: 'warn', event: 'compliance', text: 'worker-2: 4 files, no progress' },
  ],
  ...over,
})

const text = (lines: Array<{ text: string }>) => lines.map((l) => l.text).join('\n')

describe('sidebar', () => {
  it('draws the design mock: focus path open, done subtrees closed, markers, counts', () => {
    expect(`\n${text(sidebarLines(data(), { width: 36 }))}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      manager · on Payments, Reporting
      ◆ Shop
      ├ ✓ Auth
      ├ ◐ Billing
      │ ├ ▸ ✓ Invoices  +2 hidden
      │ └ ▶ Payments  3/5 steps          ●
      ├ ○ Reporting                      ●
      └ ⧗ Search  waits on user
      open questions
       ? retry semantics (Payments)
      review  design Payments · done Auth
      ! worker-2: 4 files, no progress
      ! proposal prop_1 pending review
      ? legend · /hafiz · ctrl+x v review"
    `)
  })

  it('status glyphs', () => {
    const t = indexTree(SHOP)
    const g = (id: string) => glyph(t, t.nodes.get(id) as TuiNode)
    expect(['root', 'auth', 'billing', 'payments', 'reporting', 'search'].map(g)).toEqual([
      '◆',
      '✓',
      '◐',
      '▶',
      '○',
      '⧗',
    ])
    const dropped = indexTree([node('r', null, 'R', 'active'), node('x', 'r', 'X', 'dropped')])
    expect(glyph(dropped, dropped.nodes.get('x') as TuiNode)).toBe('✗')
  })

  it('every line fits a narrow sidebar; extras give way before short titles', () => {
    const lines = sidebarLines(data(), { width: 20 })
    for (const l of lines) expect(l.text.length).toBeLessThanOrEqual(20)
    expect(`\n${text(lines)}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      manager · on Paymen…
      ◆ Shop
      ├ ✓ Auth
      ├ ◐ Billing
      │ ├ ▸ ✓ Invoices
      │ └ ▶ Payments     ●
      ├ ○ Reporting      ●
      └ ⧗ Search
      open questions
       ? retry semantics …
      review  design Paym…
      ! worker-2: 4 files,
        no progress
      ! proposal prop_1
        pending review
      ? · ctrl+x v review"
    `)
  })

  it('clicked rows override the default; detail modes cycle', () => {
    const opened = sidebarLines(data(), { width: 36, toggled: new Map([['invoices', true]]) })
    expect(text(opened)).toContain('│ │ ├ ✓ PDF export')
    const closed = sidebarLines(data(), { width: 36, toggled: new Map([['billing', false]]) })
    expect(text(closed)).toContain('├ ▸ ◐ Billing  +4 hidden')
    expect(text(closed)).not.toContain('Payments  3/5 steps')
    const full = text(sidebarLines(data(), { width: 36, detail: 'full' }))
    expect(full).toContain('PDF export')
    // focus-path only: Billing stays open (Payments is in focus) but nothing else is opened
    const focusOnly = text(
      sidebarLines(data({ focus: ['reporting'] }), { width: 36, detail: 'focus' }),
    )
    expect(focusOnly).toContain('├ ▸ ◐ Billing  +4 hidden')
    expect(nextDetail('active')).toBe('full')
    expect(nextDetail('full')).toBe('focus')
    expect(nextDetail('focus')).toBe('active')
  })

  it('a large tree is capped with "… N more", keeping focus rows', () => {
    const big: TuiNode[] = [node('r', null, 'Big', 'active')]
    for (let i = 0; i < 30; i++)
      big.push(node(`a${i}`, 'r', `Area ${i}`, i === 25 ? 'active' : 'planned'))
    const lines = sidebarLines(data({ nodes: big, focus: ['a25'], pending: [], notices: [] }), {
      width: 36,
      maxRows: 8,
    })
    const tree = lines.slice(2, -1)
    expect(tree).toHaveLength(8)
    expect(text(tree)).toContain('Area 25')
    expect(tree.at(-1)?.text).toBe('… 24 more')
  })

  it('unmanaged sessions and empty projects degrade to a header', () => {
    expect(text(sidebarLines(data({ role: undefined })))).toContain('not managed by Hafiz')
    expect(text(sidebarLines(data({ role: undefined })))).not.toContain('cost')
    expect(text(sidebarLines(data({ nodes: [] })))).toBe(
      'Hafiz · shop\nmanager · on payments, reporting\nno blocks yet',
    )
    expect(text(sidebarLines(data({ focus: [] })).slice(1, 2))).toBe('manager')
  })
})

describe('panel without a tracked project', () => {
  it('off, untracked and connecting states', () => {
    expect(text(inactiveLines('off'))).toBe('Hafiz · off (not a git repo)')
    expect(text(inactiveLines('untracked'))).toBe(
      'Hafiz · untracked\nstarts when work turns multi-step',
    )
    expect(inactiveLines('off').map((l) => l.tone)).toEqual(['muted'])
    expect(inactiveLines('untracked').map((l) => l.tone)).toEqual(['title', 'muted'])
    expect(text(connectingLines('shop'))).toBe('Hafiz · shop — connecting…')
    expect(text(connectingLines('a-very-long-project-name-indeed', 24))).toHaveLength(24)
  })
})

describe('status chip', () => {
  it('first focus block, extra focus count, pending; empty without a tree', () => {
    expect(statusChip(data())).toBe('◆ Payments +1 · 2 pending')
    expect(statusChip(data({ focus: [], pending: [] }))).toBe('◆ shop')
    expect(statusChip(data({ nodes: [] }))).toBe('')
  })
})

describe('route: tree tab', () => {
  it('selection marker and keys: move, open, close, back to parent', () => {
    const r0 = routeTree(SHOP, ['payments'], { toggled: new Map(), selected: 'invoices' }, 30)
    expect(`\n${text(r0.lines)}`).toMatchInlineSnapshot(`
      "
       ◆ Shop
       ├ ✓ Auth
       ├ ◐ Billing
      ›│ ├ ▸ ✓ Invoices  +2 hidden
       │ └ ▶ Payments  3/5 steps   ●
       ├ ○ Reporting
       └ ⧗ Search  waits on user"
    `)
    const open = treeKey(r0.rows, r0.selected, new Map(), 'expand')
    expect(open.toggled.get('invoices')).toBe(true)
    const r1 = routeTree(SHOP, ['payments'], { toggled: open.toggled, selected: open.selected }, 30)
    expect(text(r1.lines)).toContain('│ │ ├ ✓ PDF export')
    const down = treeKey(r1.rows, r1.selected, open.toggled, 'down')
    expect(down.selected).toBe('pdf')
    const parent = treeKey(
      r1.rows,
      r1.rows.findIndex((r) => r.node.id === 'pdf'),
      open.toggled,
      'collapse',
    )
    expect(parent.selected).toBe('invoices')
    const close = treeKey(r1.rows, r1.selected, open.toggled, 'collapse')
    expect(close.toggled.get('invoices')).toBe(false)
    expect(treeKey(r1.rows, 0, open.toggled, 'up').selected).toBe('root')
  })

  it('flatten honours the open set', () => {
    const t = indexTree(SHOP)
    expect(flatten(t, () => false).map((r) => r.node.id)).toEqual(['root'])
    expect(flatten(t, () => true)).toHaveLength(SHOP.length)
  })
})

describe('route: review and decisions tabs', () => {
  const props: Proposal[] = [
    {
      id: 'prop_1',
      kind: 'decision',
      source: 'condenser',
      blockId: 'payments',
      payload: { command: 'decision.record', args: { block: 'payments', title: 'Retry 3x' } },
      note: 'condenser: the user seems to have decided "Retry 3x": retry failed charges three times',
      status: 'pending',
      createdAt: '2026-10-02T09:30:00Z',
    },
    {
      id: 'prop_2',
      kind: 'digest',
      source: 'drafter',
      payload: { command: 'doc.write', args: {} },
      status: 'pending',
      createdAt: '2026-10-02T09:31:00Z',
    },
  ]

  it('list and read-only detail with the CLI hint', () => {
    expect(`\n${text(reviewList(props, 0, 40))}`).toMatchInlineSnapshot(`
      "
      ›decision condenser  condenser: the use…
       digest   drafter"
    `)
    const titles = new Map(SHOP.map((n) => [n.id, n.title]))
    expect(`\n${text(reviewDetail(props[0], titles, 44))}`).toMatchInlineSnapshot(`
      "
      proposal prop_1
      kind     decision
      source   condenser
      block    Payments [payments]
      created  2026-10-02 09:30

      condenser: the user seems to have decided
      "Retry 3x": retry failed charges three times

      would run:
        decision.record
        {"block":"payments","title":"Retry 3x"}

      accept or reject in the review overlay: ctr…"
    `)
    expect(text(reviewList([], 0, 40))).toBe('nothing pending review')
  })

  it('standing decisions and recent decisions per block', () => {
    const standing = [decision('d9', 'root', 'Card data', 'never')]
    expect(`\n${text(decisionLines(standing, SHOP, 60))}`).toMatchInlineSnapshot(`
      "
      standing (the floor every view carries)
        never: Card data — Card data decided. (Shop)

      recent decisions by block
        Billing  (+2 older)
          2026-10-01  Cents — Cents decided.
          2026-10-01  Stripe — Stripe decided."
    `)
  })
})

describe('notices', () => {
  it('wraps in the sidebar to 3 lines then ellipsis', () => {
    const long =
      'Hafiz: this session has 3 tool calls across 0 files and a very long tail of words that goes on'
    expect(noticeWrap(long, 24).join('\n')).toMatchInlineSnapshot(`
      "! Hafiz: this session
        has 3 tool calls
        across 0 files and a…"
    `)
    expect(noticeWrap('short', 24)).toEqual(['! short'])
  })

  it('lists every notice in full, newest first, with timestamps', () => {
    const ns = [
      {
        level: 'info',
        event: 'proposal',
        text: 'proposal prop_1 pending review',
        ts: '2026-10-21T10:00:00Z',
      },
      {
        level: 'warn',
        event: 'compliance',
        text: 'worker-2: 4 files, no progress and a long explanation',
        ts: '2026-10-21T11:30:00Z',
      },
    ]
    expect(`\n${text(noticeLines(ns, 30))}`).toMatchInlineSnapshot(`
      "
      2026-10-21 11:30  compliance
        worker-2: 4 files, no
        progress and a long
        explanation

      2026-10-21 10:00  proposal
        proposal prop_1 pending
        review"
    `)
    expect(text(noticeLines([], 30))).toBe('no notices')
  })
})

// A shop mid-feature: checkout under way, a gated design waiting, a rejected plan.
const gate = (
  type: 'design' | 'plan',
  status: 'pending' | 'rejected',
  mode: 'gate' | 'queue' = 'gate',
) => ({ [type]: { proposal: `prop_${type}`, version: 2, status, mode } })
const CHECKOUT: TuiNode[] = [
  node('root', null, 'Shop', 'active'),
  node('checkout', 'root', 'Checkout', 'active', {
    threads: [
      { id: 'q1', title: 'guest checkout?', status: 'open' },
      { id: 'q2', title: 'saved cards', status: 'parked' },
    ],
  }),
  node('orders', 'checkout', 'Orders', 'planned', { review: gate('design', 'pending') }),
  node('discounts', 'orders', 'Order discounts', 'planned'),
  node('coupons', 'orders', 'Coupons', 'planned'),
  node('cart', 'checkout', 'Cart totals', 'active', {
    steps: { done: 2, total: 5 },
    review: gate('plan', 'rejected'),
  }),
  node('pricing', 'root', 'Pricing', 'active', {
    steps: { done: 1, total: 3 },
    review: gate('design', 'pending', 'queue'),
    threads: [
      { id: 'q3', title: 'round half up?', status: 'open' },
      { id: 'q4', title: 'currency per region', status: 'open' },
      { id: 'q5', title: 'tax inclusive', status: 'open' },
    ],
  }),
  node('tax', 'pricing', 'Tax', 'blocked', { blockedOn: { kind: 'user' } }),
]
const QUEUE: ReviewItem[] = [
  review('prop_design', 'design', 'review', 'orders', 'Orders', {
    version: 2,
    mode: 'gate',
    note: "design v2 of 'Orders': changed since v1: scope, interface (+1 provides)",
    createdAt: '2026-10-22T09:55:00Z',
  }),
  review('prop_done', 'status', 'auto_done', 'cart', 'Cart totals', {
    mode: 'gate',
    note: "worker requests 'Cart totals' be marked done; digest written.",
    createdAt: '2026-10-22T07:00:00Z',
  }),
  review('prop_draft', 'decision', 'condenser', 'pricing', 'Pricing', {
    note: 'condenser: the user seems to have decided "round half even"',
    createdAt: '2026-10-19T10:00:00Z',
  }),
]
const NOW = Date.parse('2026-10-22T10:00:00Z')

describe('sidebar: mid-feature states', () => {
  const mid = (over: Partial<SidebarData> = {}): SidebarData => ({
    project: 'shop',
    role: 'manager',
    focus: ['checkout', 'pricing'],
    nodes: CHECKOUT,
    pending: QUEUE,
    notices: [],
    ...over,
  })

  it('manager mid-feature: focus titles, gate marks, open questions, the review line', () => {
    expect(`\n${text(sidebarLines(mid(), { width: 40 }))}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      manager · on Checkout, Pricing
      ◆ Shop
      ├ ◐ Checkout                           ●
      │ ├ ▸ ○ Orders (review)  +2 hidden
      │ └ ▶ Cart totals (rejected)  2/5 steps
      └ ◐ Pricing  1/3 steps                 ●
        └ ⧗ Tax  waits on user
      open questions
       ? guest checkout? (Checkout)
       ? round half up? (Pricing)
       ? currency per region (Pricing)
       … 1 more
      review  design Orders · 2 more
      ? legend · /hafiz tree · ctrl+x v review"
    `)
  })

  it('worker on one block: only its questions; folded rows keep their glyph', () => {
    const lines = sidebarLines(mid({ role: 'worker', focus: ['cart'], pending: [] }), {
      width: 40,
      toggled: new Map([['orders', false]]),
    })
    expect(`\n${text(lines)}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      worker · on Cart totals
      ◆ Shop
      ├ ◐ Checkout
      │ ├ ▸ ○ Orders (review)  +2 hidden
      │ └ ▶ Cart tota… (rejected)  2/5 steps ●
      └ ◐ Pricing  1/3 steps
        └ ⧗ Tax  waits on user
      ? legend · /hafiz tree · ctrl+x v review"
    `)
  })

  it('gated and rejected blocks; queue-mode reviews leave the tree alone', () => {
    const n = (id: string) => CHECKOUT.find((x) => x.id === id) as TuiNode
    expect(['orders', 'cart', 'pricing', 'tax'].map((id) => reviewMark(n(id)))).toEqual([
      '(review)',
      '(rejected)',
      '',
      '',
    ])
    // narrow: the title is cut, the mark stays
    const narrow = sidebarLines(mid(), { width: 24 })
    for (const l of narrow) expect(l.text.length).toBeLessThanOrEqual(24)
    expect(`\n${text(narrow)}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      manager · on Checkout, …
      ◆ Shop
      ├ ◐ Checkout           ●
      │ ├ ▸ ○ Orders (review)
      │ └ ▶ Cart t… (rejected)
      └ ◐ Pricing  1/3 steps ●
        └ ⧗ Tax  waits on user
      open questions
       ? guest checkout? (Che…
       ? round half up? (Pric…
       ? currency per region …
       … 1 more
      review  design… · 2 more
      ? · ctrl+x v review"
    `)
  })

  it('the legend opens under the footer; footer and review rows are clickable', () => {
    const lines = sidebarLines(mid({ notices: [] }), { width: 36, legend: true })
    expect(`\n${text(lines.slice(-8))}`).toMatchInlineSnapshot(`
      "
      ? legend · /hafiz · ctrl+x v review
      ◆ root  ● this session's focus
      ▶ active  ◐ active, has children
      ○ planned  ⧗ blocked  ✗ dropped
      ✓ done  ▸ folded (click to open)
      (review) gated until accepted
      (rejected) gated until revised
      ? open question on your focus"
    `)
    expect(lines.slice(-8).every((l) => l.action === 'legend')).toBe(true)
    expect(lines.find((l) => l.text.startsWith('review'))?.action).toBe('review')
    expect(footerLine(40, 'ctrl+x v')).toBe('? legend · /hafiz tree · ctrl+x v review')
    expect(footerLine(30, 'ctrl+x v')).toBe('? legend · ctrl+x v review')
  })

  it('review line: queue order, as many as fit, the rest counted', () => {
    expect(reviewSummary(QUEUE, 60)).toBe(
      'review  design Orders · done Cart totals · decision Pricing',
    )
    expect(reviewSummary(QUEUE, 40)).toBe('review  design Orders · 2 more')
    expect(reviewSummary(QUEUE, 24)).toBe('review  design… · 2 more')
    expect(reviewSummary(QUEUE.slice(0, 1), 12)).toBe('review  des…')
  })

  it('the cost line heads the Notices tab', () => {
    const counters = { view_emits: 7, condense_tokens_in: 12000, condense_tokens_out: 1000 }
    expect(costLine(counters)).toBe('cost  7 re-emits · cond 13k tok')
    expect(text(noticeLines([], 40, counters))).toBe(
      'cost  7 re-emits · cond 13k tok\n\nno notices',
    )
  })
})

describe('review overlay', () => {
  it('list: rows with notes, selection, footer; empty', () => {
    expect(reviewOverlayTitle(3)).toBe('Hafiz review · 3 pending')
    expect(`\n${text(reviewOverlayRows(QUEUE, 1, 84, NOW))}`).toMatchInlineSnapshot(`
      "
        design  Orders v2  ·  review · 5m  ·  gate
          design v2 of 'Orders': changed since v1: scope, interface (+1 provides)
      › done  Cart totals  ·  auto_done · 3h  ·  gate
          worker requests 'Cart totals' be marked done; digest written.
        decision  Pricing  ·  condenser · 3d  ·  queue
          condenser: the user seems to have decided "round half even""
    `)
    expect(reviewOverlayRows(QUEUE, 1, 84, NOW).map((l) => l.tone)).toEqual([
      'warning',
      'muted',
      'accent',
      'muted',
      'text',
      'muted',
    ])
    expect(text(reviewOverlayFooter(QUEUE[1], 84))).toMatchInlineSnapshot(`
      "worker requests 'Cart totals' be marked done; digest written.
      ↑↓ move · ⏎ open · a accept · r reject · esc close"
    `)
    expect(text(reviewOverlayRows([], 0, 84, NOW))).toBe('nothing pending review')
    expect(text(reviewOverlayFooter(undefined, 84))).toBe('esc close')
  })

  it('detail: title, who and what waits, the doc with changed headings, decisions, questions', () => {
    const shown = {
      item: QUEUE[0] as ReviewItem,
      doc: { version: 2, by: { role: 'designer', agent: 'hafiz-designer' } },
      text: [
        'Purpose: orders as records',
        'Scope:',
        '- in: order lines',
        '- out: refunds',
        'Interface: provides createOrder(); consumes cart',
      ].join('\n'),
      changed: { since: 1, sections: ['scope', 'interface'], removed: ['risks'] },
      previous: { version: 1, text: 'Purpose: orders\nScope: in: order lines' },
    }
    const orders = {
      ...(CHECKOUT.find((x) => x.id === 'orders') as TuiNode),
      decisions: 3,
      recentDecisions: [decision('d1', 'orders', 'Ids', undefined)],
      threads: [{ id: 'q9', title: 'split shipments?', status: 'open' as const }],
    }
    expect(reviewDetailTitle(shown.item)).toBe('design review · Orders [orders] v2')
    expect(reviewDetailMeta(shown, NOW)).toBe(
      'by designer (hafiz-designer) · 5m · gate: planner and workers wait',
    )
    expect(`\n${text(reviewDetailBody(shown, orders, 60))}`).toMatchInlineSnapshot(`
      "
      Purpose: orders as records
      Scope (changed since v1):
      - in: order lines
      - out: refunds
      Interface (changed since v1): provides createOrder();
        consumes cart
      removed since v1: risks

      Decisions on this block
        Ids — Ids decided.
        +2 older

      Open questions
        ? split shipments?"
    `)
    expect(`\n${text(reviewDetailBody(shown, undefined, 60, true))}`).toMatchInlineSnapshot(`
      "
      previous: v1
      Purpose: orders
      Scope: in: order lines"
    `)
    expect(reviewDetailFooter(false)).toBe(
      '↑↓ scroll · d previous version · a accept · r reject · esc back',
    )
    // done and draft items: the text from review.show, the source as author
    const done = { item: QUEUE[1] as ReviewItem, doc: null, text: 'block.set_status {"id":"cart"}' }
    expect(reviewDetailTitle(done.item)).toBe('done review · Cart totals [cart]')
    expect(reviewDetailMeta(done, NOW)).toBe('by auto_done · 3h · gate: done waits')
    const draft = { item: QUEUE[2] as ReviewItem, doc: null, text: 'Decision: round half even' }
    expect(reviewDetailMeta(draft, NOW)).toBe('by condenser · 3d · queue')
    expect(text(reviewDetailBody(draft, undefined, 60, true))).toBe('no previous version')
  })

  it('reject prompt and toasts', () => {
    expect(rejectTitle(QUEUE[0] as ReviewItem)).toBe('reject design · Orders v2')
    expect(REJECT_HINT).toBe('Why? One or two lines. The manager sees this as a notice.')
    expect(acceptedToast(QUEUE[0] as ReviewItem)).toBe(
      'design Orders v2 accepted · planner may start',
    )
    expect(acceptedToast({ ...(QUEUE[0] as ReviewItem), mode: 'queue' })).toBe(
      'design Orders v2 accepted',
    )
    expect(acceptedToast(QUEUE[2] as ReviewItem)).toBe('decision Pricing accepted')
    expect(rejectedToast(QUEUE[0] as ReviewItem)).toBe('design Orders v2 rejected')
  })
})
