// View models for the Kilo TUI panel: pure functions from daemon data to text rows. The Solid
// components (plugin.tsx) only colour and lay these out, so everything that decides what the
// sidebar, the status chip and the /hafiz route show is tested here as golden text.
import {
  type DecisionBrief,
  type Proposal,
  type ReviewItem,
  sectionLabel,
  type TreeSummaryNode,
} from '@hafiz/core'

export type TuiNode = TreeSummaryNode

/** How much of the tree the sidebar opens by default (cycled by a keybind). */
export type SidebarDetail = 'active' | 'full' | 'focus'
export const SIDEBAR_DETAILS: readonly SidebarDetail[] = ['active', 'full', 'focus']

export function nextDetail(d: SidebarDetail): SidebarDetail {
  return SIDEBAR_DETAILS[(SIDEBAR_DETAILS.indexOf(d) + 1) % SIDEBAR_DETAILS.length] as SidebarDetail
}

/** Colour role of a line; the component maps it to the theme. */
export type Tone = 'title' | 'text' | 'muted' | 'accent' | 'success' | 'warning' | 'error'

export interface Line {
  text: string
  tone: Tone
  /** A tree row: the block it shows. */
  id?: string
  /** Clicking the row toggles its subtree. */
  toggle?: boolean
  /** For toggle rows: the subtree is open. */
  expanded?: boolean
  /** Clicking the row opens the review overlay or toggles the glyph legend. */
  action?: 'review' | 'legend'
}

// ─────────────────────────────── tree ───────────────────────────────

export interface Tree {
  nodes: Map<string, TuiNode>
  children: Map<string | null, string[]>
  roots: string[]
}

/** Index summary nodes (depth-first order) by id and parent. */
export function indexTree(nodes: readonly TuiNode[]): Tree {
  const map = new Map<string, TuiNode>()
  const children = new Map<string | null, string[]>()
  for (const n of nodes) map.set(n.id, n)
  for (const n of nodes) {
    const parent = n.parentId && map.has(n.parentId) ? n.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), n.id])
  }
  return { nodes: map, children, roots: children.get(null) ?? [] }
}

const kids = (t: Tree, id: string) => t.children.get(id) ?? []

function descendants(t: Tree, id: string): number {
  let n = 0
  for (const c of kids(t, id)) n += 1 + descendants(t, c)
  return n
}

/** ◆ root · ✓ done · ▶ active · ◐ active with children · ○ planned · ⧗ blocked · ✗ dropped */
export function glyph(t: Tree, n: TuiNode): string {
  if (n.parentId === null || !t.nodes.has(n.parentId)) return '◆'
  switch (n.status) {
    case 'done':
      return '✓'
    case 'active':
      return kids(t, n.id).length ? '◐' : '▶'
    case 'blocked':
      return '⧗'
    case 'dropped':
      return '✗'
    default:
      return '○'
  }
}

export function statusTone(n: TuiNode): Tone {
  switch (n.status) {
    case 'done':
      return 'success'
    case 'active':
      return 'accent'
    case 'blocked':
      return 'warning'
    case 'dropped':
      return 'muted'
    default:
      return 'text'
  }
}

/**
 * Default open/closed state of a node with children. Roots are always open. `active` (the
 * default) opens the path to every focus block and every active block; `focus` only the path to
 * focus blocks; `full` everything. Done and planned subtrees off those paths stay closed.
 */
export function defaultExpanded(
  t: Tree,
  focus: ReadonlySet<string>,
  detail: SidebarDetail,
): Set<string> {
  const open = new Set<string>(t.roots)
  const wanted = (n: TuiNode) =>
    focus.has(n.id) || (detail === 'active' && (n.status === 'active' || n.status === 'blocked'))
  for (const n of t.nodes.values()) {
    if (detail === 'full') {
      open.add(n.id)
      continue
    }
    if (!wanted(n)) continue
    // open every ancestor so the node is visible
    let p = n.parentId
    while (p && t.nodes.has(p)) {
      open.add(p)
      p = t.nodes.get(p)?.parentId ?? null
    }
  }
  return open
}

export interface FlatRow {
  node: TuiNode
  /** Box-drawing prefix (`│ ├ `). */
  prefix: string
  hasChildren: boolean
  expanded: boolean
  /** Descendants hidden under a closed row. */
  hidden: number
}

/** Visible rows in tree order for a given open set. */
export function flatten(t: Tree, isOpen: (id: string) => boolean): FlatRow[] {
  const out: FlatRow[] = []
  const walk = (id: string, lead: string, last: boolean, top: boolean) => {
    const node = t.nodes.get(id)
    if (!node) return
    const cs = kids(t, id)
    const expanded = cs.length > 0 && isOpen(id)
    out.push({
      node,
      prefix: top ? '' : `${lead}${last ? '└ ' : '├ '}`,
      hasChildren: cs.length > 0,
      expanded,
      hidden: expanded ? 0 : descendants(t, id),
    })
    if (!expanded) return
    const nextLead = top ? '' : `${lead}${last ? '  ' : '│ '}`
    for (const [i, c] of cs.entries()) walk(c, nextLead, i === cs.length - 1, false)
  }
  for (const [i, r] of t.roots.entries()) walk(r, '', i === t.roots.length - 1, true)
  return out
}

/** Cut `s` to `w` cells with an ellipsis. */
export function clip(s: string, w: number): string {
  if (w <= 0) return ''
  if (s.length <= w) return s
  return w === 1 ? '…' : `${s.slice(0, w - 1)}…`
}

function blockedNote(n: TuiNode): string {
  return n.status === 'blocked' && n.blockedOn ? `waits on ${n.blockedOn.kind}` : ''
}

/**
 * `(review)` while a gated design or plan review is pending on the block, `(rejected)` while a
 * gated one stands rejected; queue-mode reviews do not mark the tree.
 */
export function reviewMark(n: TuiNode): string {
  for (const type of ['design', 'plan'] as const) {
    const r = n.review?.[type]
    if (r?.mode === 'gate') return r.status === 'rejected' ? '(rejected)' : '(review)'
  }
  return ''
}

/**
 * One tree row: `prefix [▸ ]glyph title (review)  +2 hidden  3/5 steps  waits on user` with the
 * focus marker `●` at the right edge. When the width is short the title is cut first, down to 8
 * cells; below that the extras (hidden count, steps, blocked-on) are dropped so the title and its
 * review mark stay readable.
 */
export function treeRowText(
  t: Tree,
  r: FlatRow,
  width: number,
  o: { focus?: boolean; marker?: boolean } = {},
): string {
  const n = r.node
  const closed = r.hasChildren && !r.expanded
  const head = `${r.prefix}${closed ? '▸ ' : ''}${glyph(t, n)} `
  const extras = [
    closed ? `+${r.hidden} hidden` : '',
    n.steps ? `${n.steps.done}/${n.steps.total} steps` : '',
    blockedNote(n),
  ].filter(Boolean)
  const mark = o.focus ? '●' : ''
  const gate = reviewMark(n)
  const tail = extras.join('  ')
  const room = width - head.length - (mark ? 2 : 0)
  const titled = (w: number) =>
    gate && w - gate.length - 1 >= Math.min(4, n.title.length)
      ? `${clip(n.title, w - gate.length - 1)} ${gate}`
      : clip(n.title, w)
  const full = n.title.length + (gate ? gate.length + 1 : 0)
  let body: string
  if (room - (tail ? tail.length + 2 : 0) >= Math.min(8 + (gate ? gate.length + 1 : 0), full)) {
    const titleRoom = room - (tail ? tail.length + 2 : 0)
    body = tail ? `${titled(titleRoom)}  ${tail}` : titled(titleRoom)
  } else body = titled(room)
  if (!mark) return clip(head + body, width)
  const left = head + body
  const pad = Math.max(1, width - left.length - 1)
  return clip(`${left}${' '.repeat(pad)}${mark}`, width)
}

// ─────────────────────────────── sidebar ───────────────────────────────

export interface SidebarNotice {
  level: string
  event: string
  text: string
  ts?: string | undefined
}

export interface SidebarData {
  project: string
  /** Role of this Kilo session; undefined when Hafiz does not manage it. */
  role?: string | undefined
  focus: readonly string[]
  nodes: readonly TuiNode[]
  /** The review queue (pending), in queue order. */
  pending: readonly ReviewRow[]
  /** This session's recent notices, oldest first. */
  notices: readonly SidebarNotice[]
}

/** What the panel needs of a review queue item (`review.list`). */
export type ReviewRow = Pick<
  ReviewItem,
  'id' | 'kind' | 'source' | 'blockId' | 'note' | 'createdAt' | 'mode' | 'blockTitle' | 'version'
>

export interface SidebarOptions {
  width?: number
  detail?: SidebarDetail
  /** Rows the user opened/closed by clicking (overrides the default). */
  toggled?: ReadonlyMap<string, boolean>
  /** Most tree rows shown before `… N more`. */
  maxRows?: number
  /** The glyph legend is open under the footer. */
  legend?: boolean
  /** How the review overlay's key reads in the footer. */
  reviewKey?: string
}

/** 1234 → 1.2k */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

const NOTICE_LINES = 3

/** A notice as `! text` wrapped to the sidebar: at most 3 lines, the last ending in `…` if cut. */
export function noticeWrap(text: string, width: number): string[] {
  const lines = wrap(text, Math.max(8, width - 2)).map((l, i) => `${i ? '  ' : '! '}${l}`)
  if (lines.length <= NOTICE_LINES) return lines
  const kept = lines.slice(0, NOTICE_LINES)
  kept[NOTICE_LINES - 1] = `${clip(kept[NOTICE_LINES - 1] as string, width - 1)}…`
  return kept
}

/** The tree rows for the sidebar, capped: focus rows (and their paths) are kept first. */
export function sidebarTree(data: SidebarData, opts: SidebarOptions = {}): Line[] {
  const width = opts.width ?? 40
  const maxRows = Math.max(3, opts.maxRows ?? 14)
  const t = indexTree(data.nodes)
  const focus = new Set(data.focus)
  const open = defaultExpanded(t, focus, opts.detail ?? 'active')
  const isOpen = (id: string) => opts.toggled?.get(id) ?? open.has(id)
  const rows = flatten(t, isOpen)
  const line = (r: FlatRow): Line => ({
    text: treeRowText(t, r, width, { focus: focus.has(r.node.id) }),
    tone: statusTone(r.node),
    id: r.node.id,
    ...(r.hasChildren ? { toggle: true, expanded: r.expanded } : {}),
  })
  if (rows.length <= maxRows) return rows.map(line)
  // Keep the root, every focus row and its visible ancestors, then fill in tree order.
  const keep = new Set<number>([0])
  const index = new Map(rows.map((r, i) => [r.node.id, i]))
  for (const [i, r] of rows.entries()) {
    if (!focus.has(r.node.id)) continue
    let id: string | null = r.node.id
    while (id) {
      const at = index.get(id)
      if (at !== undefined) keep.add(at)
      id = t.nodes.get(id)?.parentId ?? null
    }
    keep.add(i)
  }
  const budget = maxRows - 1 // one line for "… N more"
  for (let i = 0; i < rows.length && keep.size < budget; i++) keep.add(i)
  const shown = [...keep].sort((a, b) => a - b).slice(0, Math.max(budget, 1))
  const out = shown.map((i) => line(rows[i] as FlatRow))
  out.push({ text: clip(`… ${rows.length - shown.length} more`, width), tone: 'muted' })
  return out
}

/** What the sidebar and the `/hafiz` route show without a Hafiz project (nothing is connected). */
export function inactiveLines(kind: 'off' | 'untracked', width = 40): Line[] {
  if (kind === 'off') return [{ text: clip('Hafiz · off (not a git repo)', width), tone: 'muted' }]
  return [
    { text: clip('Hafiz · untracked', width), tone: 'title' },
    { text: clip('starts when work turns multi-step', width), tone: 'muted' },
  ]
}

/** A tracked project whose daemon has not answered yet. */
export function connectingLines(project: string, width = 40): Line[] {
  return [{ text: clip(`Hafiz · ${project} — connecting…`, width), tone: 'muted' }]
}

/** The review overlay's default key, as the footer shows it. */
export const REVIEW_KEY_LABEL = 'ctrl+x v'

/** What the legend under the sidebar footer explains, one line each. */
export const LEGEND: readonly string[] = [
  "◆ root  ● this session's focus",
  '▶ active  ◐ active, has children',
  '○ planned  ⧗ blocked  ✗ dropped',
  '✓ done  ▸ folded (click to open)',
  '(review) gated until accepted',
  '(rejected) gated until revised',
  '? open question on your focus',
]

/** How a queue item's kind reads: design, plan, done, or the drafted record (decision, digest…). */
export function reviewKind(p: Pick<ReviewRow, 'kind' | 'source'>): string {
  return p.source === 'auto_done' ? 'done' : p.kind
}

const reviewLabel = (p: ReviewRow) =>
  [reviewKind(p), p.blockTitle ?? p.blockId ?? ''].filter(Boolean).join(' ')

/**
 * `review  design Orders · done Cart totals · 2 more`: pending items in queue order, as many as
 * fit, the rest counted; the first item is clipped rather than dropped.
 */
export function reviewSummary(items: readonly ReviewRow[], width: number): string {
  const head = 'review  '
  const parts = items.map(reviewLabel)
  for (let k = parts.length; k >= 1; k--) {
    const more = parts.length - k
    const line = `${head}${parts.slice(0, k).join(' · ')}${more ? ` · ${more} more` : ''}`
    if (line.length <= width) return line
  }
  const more = parts.length > 1 ? ` · ${parts.length - 1} more` : ''
  const room = width - head.length - more.length
  return room >= 4 ? `${head}${clip(parts[0] ?? '', room)}${more}` : clip(head + parts[0], width)
}

/** The role line: `manager · on Checkout, Pricing` (focus block titles); `manager` without focus. */
export function roleLine(data: Pick<SidebarData, 'role' | 'focus' | 'nodes'>): string {
  if (!data.role) return 'not managed by Hafiz'
  const byId = new Map(data.nodes.map((n) => [n.id, n.title]))
  const titles = data.focus.map((id) => byId.get(id) ?? id)
  return titles.length ? `${data.role} · on ${titles.join(', ')}` : data.role
}

/** Everything the sidebar slot shows, as lines. */
export function sidebarLines(data: SidebarData, opts: SidebarOptions = {}): Line[] {
  const width = opts.width ?? 40
  const out: Line[] = []
  const add = (text: string, tone: Tone, extra: Partial<Line> = {}) =>
    out.push({ text: clip(text, width), tone, ...extra })
  add(`Hafiz · ${data.project}`, 'title')
  add(roleLine(data), 'muted')
  if (data.nodes.length === 0) {
    add('no blocks yet', 'muted')
    return out
  }
  out.push(...sidebarTree(data, opts))

  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const open = data.focus.flatMap((id) =>
    (byId.get(id)?.threads ?? [])
      .filter((th) => th.status === 'open')
      .map((th) => ({ th, block: byId.get(id)?.title ?? id })),
  )
  if (open.length) {
    add('open questions', 'text')
    for (const { th, block } of open.slice(0, 3)) add(` ? ${th.title} (${block})`, 'muted')
    if (open.length > 3) add(` … ${open.length - 3} more`, 'muted')
  }
  if (data.pending.length)
    out.push({ text: reviewSummary(data.pending, width), tone: 'warning', action: 'review' })
  for (const n of [...data.notices].reverse().slice(0, 3))
    for (const l of noticeWrap(n.text, width)) add(l, n.level === 'warn' ? 'warning' : 'muted')
  out.push({ text: footerLine(width, opts.reviewKey), tone: 'muted', action: 'legend' })
  if (opts.legend) for (const l of LEGEND) add(l, 'muted', { action: 'legend' })
  return out
}

/** `? legend · /hafiz tree · ctrl+x v review`, shortened until it fits. */
export function footerLine(width: number, reviewKey = REVIEW_KEY_LABEL): string {
  const options = [
    `? legend · /hafiz tree · ${reviewKey} review`,
    `? legend · /hafiz · ${reviewKey} review`,
    `? legend · ${reviewKey} review`,
    `? · ${reviewKey} review`,
  ]
  return options.find((o) => o.length <= width) ?? clip(options.at(-1) as string, width)
}

/** `cost  7 re-emits · cond 13k tok`: what Hafiz cost this session. */
export function costLine(counters: Readonly<Record<string, number>>): string {
  const emits = counters.view_emits ?? 0
  const cond = (counters.condense_tokens_in ?? 0) + (counters.condense_tokens_out ?? 0)
  return `cost  ${emits} re-emit${emits === 1 ? '' : 's'} · cond ${compact(cond)} tok`
}

/** `◆ <first focus block> · N pending` for the prompt's right side; empty without a tree. */
export function statusChip(data: Pick<SidebarData, 'nodes' | 'focus' | 'pending' | 'project'>) {
  if (data.nodes.length === 0) return ''
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const first = data.focus.map((id) => byId.get(id)).find(Boolean)
  const more = first && data.focus.length > 1 ? ` +${data.focus.length - 1}` : ''
  const label = clip(first?.title ?? data.project, 24)
  const n = data.pending.length
  return `◆ ${label}${more}${n ? ` · ${n} pending` : ''}`
}

// ─────────────────────────────── route: tree tab ───────────────────────────────

export interface RouteTreeState {
  /** Rows the user opened or closed; others follow the `active` default. */
  toggled: ReadonlyMap<string, boolean>
  selected?: string | undefined
}

/** Left pane of the Tree tab: every visible row plus which one is selected. */
export function routeTree(
  nodes: readonly TuiNode[],
  focus: readonly string[],
  state: RouteTreeState,
  width: number,
): { lines: Line[]; rows: FlatRow[]; selected: number } {
  const t = indexTree(nodes)
  const fs = new Set(focus)
  const open = defaultExpanded(t, fs, 'active')
  const rows = flatten(t, (id) => state.toggled.get(id) ?? open.has(id))
  const at = rows.findIndex((r) => r.node.id === state.selected)
  const selected = at >= 0 ? at : 0
  const lines = rows.map((r, i) => ({
    text: `${i === selected ? '›' : ' '}${treeRowText(t, r, width - 1, { focus: fs.has(r.node.id) })}`,
    tone: statusTone(r.node),
    id: r.node.id,
    ...(r.hasChildren ? { toggle: true, expanded: r.expanded } : {}),
  }))
  return { lines, rows, selected }
}

/** Key handling of the Tree tab as a pure state step. */
export function treeKey(
  rows: readonly FlatRow[],
  selected: number,
  toggled: ReadonlyMap<string, boolean>,
  key: 'up' | 'down' | 'expand' | 'collapse',
): { selected: string | undefined; toggled: Map<string, boolean> } {
  const next = new Map(toggled)
  const row = rows[selected]
  let at = selected
  if (key === 'up') at = Math.max(0, selected - 1)
  if (key === 'down') at = Math.min(rows.length - 1, selected + 1)
  if (key === 'expand' && row?.hasChildren) {
    if (!row.expanded) next.set(row.node.id, true)
    else at = Math.min(rows.length - 1, selected + 1) // already open: step into it
  }
  if (key === 'collapse' && row) {
    if (row.hasChildren && row.expanded) next.set(row.node.id, false)
    else {
      // on a leaf or closed row: go to the parent
      const parent = rows.findIndex((r) => r.node.id === row.node.parentId)
      if (parent >= 0) at = parent
    }
  }
  return { selected: rows[at]?.node.id, toggled: next }
}

export function historyLines(
  entries: ReadonlyArray<{ commit: string; ts: string; author: string; message: string }>,
  width: number,
): Line[] {
  if (!entries.length) return [{ text: 'no doc history', tone: 'muted' }]
  return entries.map((e) => ({
    text: clip(
      `${e.ts.slice(0, 16).replace('T', ' ')}  ${e.commit.slice(0, 7)}  ${e.message}`,
      width,
    ),
    tone: 'text' as Tone,
  }))
}

// ─────────────────────────────── route: review tab ───────────────────────────────

export function reviewList(pending: readonly Proposal[], selected: number, width: number): Line[] {
  if (!pending.length) return [{ text: 'nothing pending review', tone: 'muted' }]
  return pending.map((p, i) => ({
    text: clip(
      `${i === selected ? '›' : ' '}${p.kind.padEnd(8)} ${p.source.padEnd(10)} ${p.note ?? ''}`.trimEnd(),
      width,
    ),
    tone: (i === selected ? 'accent' : 'text') as Tone,
  }))
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = ''
      }
      line = line ? `${line} ${word}` : word.length > width ? clip(word, width) : word
    }
    out.push(line)
  }
  return out
}

export function reviewDetail(
  p: Proposal | undefined,
  blocks: ReadonlyMap<string, string>,
  width: number,
  reviewKey = REVIEW_KEY_LABEL,
): Line[] {
  if (!p) return []
  const out: Line[] = []
  const add = (text: string, tone: Tone) => out.push({ text: clip(text, width), tone })
  add(`proposal ${p.id}`, 'title')
  add(`kind     ${p.kind}`, 'text')
  add(`source   ${p.source}`, 'text')
  if (p.blockId) add(`block    ${blocks.get(p.blockId) ?? p.blockId} [${p.blockId}]`, 'text')
  add(`created  ${p.createdAt.slice(0, 16).replace('T', ' ')}`, 'muted')
  if (p.note) {
    add('', 'text')
    for (const l of wrap(p.note, width)) add(l, 'text')
  }
  add('', 'text')
  add('would run:', 'muted')
  const cmd = `${p.payload.command} ${JSON.stringify(p.payload.args)}`
  for (const l of wrap(cmd, width - 2)) add(`  ${l}`, 'muted')
  add('', 'text')
  add(`accept or reject in the review overlay: ${reviewKey}`, 'warning')
  return out
}

// ─────────────────────────────── review overlay ───────────────────────────────

/** `now`, `5m`, `3h`, `2d`: how long ago `iso` was. */
export function age(iso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s) || s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 48 * 3600) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const versionOf = (p: Pick<ReviewRow, 'version'>) => (p.version ? ` v${p.version}` : '')

export function reviewOverlayTitle(n: number): string {
  return `Hafiz review · ${n} pending`
}

/** `design  Orders v2  ·  review · 5m  ·  gate`: one queue item in the list overlay. */
export function reviewOptionText(p: ReviewRow, now: number): string {
  const block = p.blockTitle ?? p.blockId
  const what = `${reviewKind(p)}  ${block ? `${block}${versionOf(p)}` : p.id}`
  return `${what}  ·  ${p.source} · ${age(p.createdAt, now)}  ·  ${p.mode === 'gate' ? 'gate' : 'queue'}`
}

/** The list overlay: each item and, under it, its note; `›` marks the selected one. */
export function reviewOverlayRows(
  items: readonly ReviewRow[],
  selected: number,
  width: number,
  now: number,
): Line[] {
  if (!items.length) return [{ text: 'nothing pending review', tone: 'muted' }]
  const out: Line[] = []
  for (const [i, p] of items.entries()) {
    const on = i === selected
    out.push({
      text: clip(`${on ? '›' : ' '} ${reviewOptionText(p, now)}`, width),
      tone: on ? 'accent' : p.mode === 'gate' ? 'warning' : 'text',
      id: p.id,
    })
    if (p.note) out.push({ text: clip(`    ${p.note}`, width), tone: 'muted', id: p.id })
  }
  return out
}

/** Under the list: the selected item's one-line summary and the keys. */
export function reviewOverlayFooter(p: ReviewRow | undefined, width: number): Line[] {
  if (!p) return [{ text: 'esc close', tone: 'muted' }]
  return [
    {
      text: clip(p.note ?? `${reviewKind(p)} ${p.blockTitle ?? p.blockId ?? p.id}`, width),
      tone: 'text',
    },
    { text: clip('↑↓ move · ⏎ open · a accept · r reject · esc close', width), tone: 'muted' },
  ]
}

/** What `review.show` returns, as far as the detail overlay reads it. */
export interface ReviewShown {
  item: ReviewRow
  doc: { version: number; by: { role: string; agent?: string | undefined } } | null
  text: string
  changed?: { since: number; sections: string[]; removed: string[] } | undefined
  previous?: { version: number; text: string } | undefined
}

/** `design review · Orders [blk_1] v2`. */
export function reviewDetailTitle(p: ReviewRow): string {
  const block = p.blockId ? `${p.blockTitle ?? p.blockId} [${p.blockId}]` : p.id
  return `${reviewKind(p)} review · ${block}${versionOf(p)}`
}

/** What a gate on this item holds until it is accepted. */
export function gateWaits(p: Pick<ReviewRow, 'kind' | 'source'>): string {
  const kind = reviewKind(p)
  if (kind === 'design') return 'planner and workers wait'
  if (kind === 'plan') return 'workers wait'
  if (kind === 'done') return 'done waits'
  return 'the next stage waits'
}

/** `by designer (des-1) · 5m · gate: planner and workers wait`, or `… · queue`. */
export function reviewDetailMeta(shown: ReviewShown, now: number): string {
  const p = shown.item
  const by = shown.doc
    ? `${shown.doc.by.role}${shown.doc.by.agent ? ` (${shown.doc.by.agent})` : ''}`
    : p.source
  return `by ${by} · ${age(p.createdAt, now)} · ${p.mode === 'gate' ? `gate: ${gateWaits(p)}` : 'queue'}`
}

/** Wrap one line to `width`, continuing under its own indent (+2). */
function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const indent = ' '.repeat((/^\s*/.exec(line)?.[0].length ?? 0) + 2)
  const words = wrap(line.trim(), Math.max(8, width - indent.length))
  return words.map((w, i) => (i ? `${indent}${w}` : `${indent.slice(2)}${w}`))
}

/**
 * The detail overlay's body: the doc at the reviewed version with `(changed since vM)` on the
 * headings of changed sections (or, with `previous`, the version before it, plain), then the
 * block's recent decisions and open questions from the tree summary.
 */
export function reviewDetailBody(
  shown: ReviewShown,
  node: TuiNode | undefined,
  width: number,
  previous = false,
): Line[] {
  const out: Line[] = []
  const add = (text: string, tone: Tone) => {
    for (const l of wrapLine(text, width)) out.push({ text: l, tone })
  }
  if (previous) {
    if (!shown.previous) add('no previous version', 'muted')
    else {
      add(`previous: v${shown.previous.version}`, 'muted')
      for (const l of shown.previous.text.split('\n')) add(l, 'text')
    }
  } else {
    const ch = shown.changed
    const labels = new Map((ch?.sections ?? []).map((n) => [sectionLabel(n), n]))
    for (const l of shown.text.split('\n')) {
      const head = /^([A-Z][^:]*):/.exec(l)?.[1]
      if (ch && head && labels.has(head))
        add(`${head} (changed since v${ch.since}):${l.slice(head.length + 1)}`, 'warning')
      else add(l, 'text')
    }
    if (ch?.removed.length) add(`removed since v${ch.since}: ${ch.removed.join(', ')}`, 'warning')
  }
  if (!node) return out
  out.push({ text: '', tone: 'text' })
  add('Decisions on this block', 'title')
  if (!node.recentDecisions.length) add('  none', 'muted')
  for (const d of node.recentDecisions) add(`  ${d.title} — ${d.decision}`, 'text')
  const older = node.decisions - node.recentDecisions.length
  if (older > 0) add(`  +${older} older`, 'muted')
  out.push({ text: '', tone: 'text' })
  add('Open questions', 'title')
  const open = node.threads.filter((t) => t.status === 'open')
  if (!open.length) add('  none', 'muted')
  for (const t of open) add(`  ? ${t.title}`, 'text')
  return out
}

export function reviewDetailFooter(previous: boolean): string {
  return `↑↓ scroll · d ${previous ? 'this version' : 'previous version'} · a accept · r reject · esc back`
}

/** The reject prompt's title: `reject design · Orders v2`. */
export function rejectTitle(p: ReviewRow): string {
  return `reject ${reviewKind(p)} · ${p.blockTitle ?? p.blockId ?? p.id}${versionOf(p)}`
}

export const REJECT_HINT = 'Why? One or two lines. The manager sees this as a notice.'

/** `design Orders v2 accepted · planner may start` (the start note only when it gated). */
export function acceptedToast(p: ReviewRow): string {
  const what = `${reviewKind(p)} ${p.blockTitle ?? p.blockId ?? p.id}${versionOf(p)}`
  const kind = reviewKind(p)
  const next =
    p.mode !== 'gate'
      ? ''
      : kind === 'design'
        ? ' · planner may start'
        : kind === 'plan'
          ? ' · workers may start'
          : kind === 'done'
            ? ' · block is done'
            : ''
  return `${what} accepted${next}`
}

export function rejectedToast(p: ReviewRow): string {
  return `${reviewKind(p)} ${p.blockTitle ?? p.blockId ?? p.id}${versionOf(p)} rejected`
}

// ─────────────────────────────── route: decisions tab ───────────────────────────────

export function decisionLines(
  standing: readonly DecisionBrief[],
  nodes: readonly TuiNode[],
  width: number,
): Line[] {
  const out: Line[] = []
  const add = (text: string, tone: Tone) => out.push({ text: clip(text, width), tone })
  const title = new Map(nodes.map((n) => [n.id, n.title]))
  add('standing (the floor every view carries)', 'title')
  if (!standing.length) add('  none', 'muted')
  for (const d of standing)
    add(
      `  ${d.standing}: ${d.title} — ${d.decision} (${title.get(d.blockId) ?? d.blockId})`,
      'text',
    )
  add('', 'text')
  add('recent decisions by block', 'title')
  const withDecisions = nodes.filter((n) => n.recentDecisions.length)
  if (!withDecisions.length) add('  none', 'muted')
  for (const n of withDecisions) {
    const more = n.decisions - n.recentDecisions.length
    add(`  ${n.title}${more > 0 ? `  (+${more} older)` : ''}`, 'accent')
    for (const d of n.recentDecisions)
      add(`    ${d.ts.slice(0, 10)}  ${d.title} — ${d.decision}`, 'text')
  }
  return out
}

// ─────────────────────────────── route: notices tab ───────────────────────────────

/**
 * Every notice of the session, untruncated, newest first, with its timestamp; a managed
 * session's cost (`counters`) heads the tab.
 */
export function noticeLines(
  notices: readonly SidebarNotice[],
  width: number,
  counters?: Readonly<Record<string, number>>,
): Line[] {
  const head: Line[] = counters
    ? [
        { text: clip(costLine(counters), width), tone: 'muted' },
        { text: '', tone: 'text' },
      ]
    : []
  if (!notices.length) return [...head, { text: 'no notices', tone: 'muted' }]
  const out: Line[] = [...head]
  for (const n of [...notices].reverse()) {
    const tone: Tone = n.level === 'warn' ? 'warning' : 'text'
    const when = n.ts ? `${n.ts.slice(0, 16).replace('T', ' ')}  ` : ''
    out.push({ text: clip(`${when}${n.event}`, width), tone: 'muted' })
    for (const l of wrap(n.text, width - 2)) out.push({ text: `  ${l}`, tone })
    out.push({ text: '', tone: 'text' })
  }
  out.pop()
  return out
}

// ─────────────────────────────── toasts ───────────────────────────────

/**
 * Items not seen before. The first call only primes `seen` (a TUI that starts up does not toast
 * the backlog); later calls return what is new and remember it.
 */
export function fresh<T>(
  seen: Set<string>,
  primed: boolean,
  items: readonly T[],
  key: (x: T) => string,
): T[] {
  const out: T[] = []
  for (const x of items) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    if (primed) out.push(x)
  }
  return out
}
