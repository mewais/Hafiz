// Golden text for the TUI panel's view models: what the sidebar, the status chip and the /hafiz
// route draw is decided here (the Solid components only colour these lines).
import type { Proposal } from '@hafiz/core'
import { describe, expect, it } from 'vitest'
import {
  connectingLines,
  decisionLines,
  flatten,
  glyph,
  inactiveLines,
  indexTree,
  nextDetail,
  noticeLines,
  noticeWrap,
  reviewDetail,
  reviewList,
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
  pending: 2,
  notices: [
    { level: 'info', event: 'proposal', text: 'proposal prop_1 pending review' },
    { level: 'warn', event: 'compliance', text: 'worker-2: 4 files, no progress' },
  ],
  counters: { view_emits: 3, condense_tokens_in: 1000, condense_tokens_out: 234 },
  ...over,
})

const text = (lines: Array<{ text: string }>) => lines.map((l) => l.text).join('\n')

describe('sidebar', () => {
  it('draws the design mock: focus path open, done subtrees closed, markers, counts', () => {
    expect(`\n${text(sidebarLines(data(), { width: 36 }))}`).toMatchInlineSnapshot(`
      "
      Hafiz · shop
      manager · focus 2
      ◆ Shop
      ├ ✓ Auth
      ├ ◐ Billing
      │ ├ ▸ ✓ Invoices  (2)
      │ └ ▶ Payments  3/5                ●
      ├ ○ Reporting                      ●
      └ ⧗ Search  (user)
      threads  1 open · 2 parked
       ? retry semantics (Payments)
      review  2 pending · hafiz review
      ! worker-2: 4 files, no progress
      ! proposal prop_1 pending review
      cost  3 re-emits · cond 1.2k tok"
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
      manager · focus 2
      ◆ Shop
      ├ ✓ Auth
      ├ ◐ Billing
      │ ├ ▸ ✓ Invoices
      │ └ ▶ Payments     ●
      ├ ○ Reporting      ●
      └ ⧗ Search  (user)
      threads  1 open · 2…
       ? retry semantics …
      review  2 pending ·…
      ! worker-2: 4 files,
        no progress
      ! proposal prop_1
        pending review
      cost  3 re-emits · …"
    `)
  })

  it('clicked rows override the default; detail modes cycle', () => {
    const opened = sidebarLines(data(), { width: 36, toggled: new Map([['invoices', true]]) })
    expect(text(opened)).toContain('│ │ ├ ✓ PDF export')
    const closed = sidebarLines(data(), { width: 36, toggled: new Map([['billing', false]]) })
    expect(text(closed)).toContain('├ ▸ ◐ Billing  (4)')
    expect(text(closed)).not.toContain('Payments  3/5')
    const full = text(sidebarLines(data(), { width: 36, detail: 'full' }))
    expect(full).toContain('PDF export')
    // focus-path only: Billing stays open (Payments is in focus) but nothing else is opened
    const focusOnly = text(
      sidebarLines(data({ focus: ['reporting'] }), { width: 36, detail: 'focus' }),
    )
    expect(focusOnly).toContain('├ ▸ ◐ Billing  (4)')
    expect(nextDetail('active')).toBe('full')
    expect(nextDetail('full')).toBe('focus')
    expect(nextDetail('focus')).toBe('active')
  })

  it('a large tree is capped with "… N more", keeping focus rows', () => {
    const big: TuiNode[] = [node('r', null, 'Big', 'active')]
    for (let i = 0; i < 30; i++)
      big.push(node(`a${i}`, 'r', `Area ${i}`, i === 25 ? 'active' : 'planned'))
    const lines = sidebarLines(data({ nodes: big, focus: ['a25'], pending: 0, notices: [] }), {
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
      'Hafiz · shop\nmanager · focus 2\nno blocks yet',
    )
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
    expect(statusChip(data({ focus: [], pending: 0 }))).toBe('◆ shop')
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
      ›│ ├ ▸ ✓ Invoices  (2)
       │ └ ▶ Payments  3/5         ●
       ├ ○ Reporting
       └ ⧗ Search  (user)"
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

      accept/reject with: hafiz review --accept p…"
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
