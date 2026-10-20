// View models for the Kilo TUI panel: pure functions from daemon data to text rows. The Solid
// components (plugin.tsx) only colour and lay these out, so everything that decides what the
// sidebar, the status chip and the /hafiz route show is tested here as golden text.
import type { DecisionBrief, Proposal, TreeSummaryNode } from '@hafiz/core'

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
  return n.status === 'blocked' && n.blockedOn ? `(${n.blockedOn.kind})` : ''
}

/**
 * One tree row: `prefix [▸ ]glyph title  3/5  (user)` with the focus marker `●` at the right
 * edge. When the width is short the title is cut first, down to 8 cells; below that the extras
 * (hidden count, steps, blocked-on) are dropped so the title stays readable.
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
    closed ? `(${r.hidden})` : '',
    n.steps ? `${n.steps.done}/${n.steps.total}` : '',
    blockedNote(n),
  ].filter(Boolean)
  const mark = o.focus ? '●' : ''
  const tail = extras.join('  ')
  const room = width - head.length - (mark ? 2 : 0)
  let body: string
  if (room - (tail ? tail.length + 2 : 0) >= Math.min(8, n.title.length)) {
    const titleRoom = room - (tail ? tail.length + 2 : 0)
    body = tail ? `${clip(n.title, titleRoom)}  ${tail}` : clip(n.title, titleRoom)
  } else body = clip(n.title, room)
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
}

export interface SidebarData {
  project: string
  /** Role of this Kilo session; undefined when Hafiz does not manage it. */
  role?: string | undefined
  focus: readonly string[]
  nodes: readonly TuiNode[]
  pending: number
  /** This session's recent notices, oldest first. */
  notices: readonly SidebarNotice[]
  counters?: Readonly<Record<string, number>> | undefined
}

export interface SidebarOptions {
  width?: number
  detail?: SidebarDetail
  /** Rows the user opened/closed by clicking (overrides the default). */
  toggled?: ReadonlyMap<string, boolean>
  /** Most tree rows shown before `… N more`. */
  maxRows?: number
}

/** 1234 → 1.2k */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
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

/** Everything the sidebar slot shows, as lines. */
export function sidebarLines(data: SidebarData, opts: SidebarOptions = {}): Line[] {
  const width = opts.width ?? 40
  const out: Line[] = []
  const add = (text: string, tone: Tone, extra: Partial<Line> = {}) =>
    out.push({ text: clip(text, width), tone, ...extra })
  add(`Hafiz · ${data.project}`, 'title')
  add(data.role ? `${data.role} · focus ${data.focus.length}` : 'not managed by Hafiz', 'muted')
  if (data.nodes.length === 0) {
    add('no blocks yet', 'muted')
    return out
  }
  out.push(...sidebarTree(data, opts))

  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  let open = 0
  let parked = 0
  for (const n of data.nodes) for (const th of n.threads) th.status === 'open' ? open++ : parked++
  if (open || parked) {
    add(`threads  ${open} open · ${parked} parked`, 'text')
    const listed = data.focus.flatMap((id) =>
      (byId.get(id)?.threads ?? [])
        .filter((th) => th.status === 'open')
        .map((th) => ({ th, block: byId.get(id)?.title ?? id })),
    )
    for (const { th, block } of listed.slice(0, 3)) add(` ? ${th.title} (${block})`, 'muted')
    if (listed.length > 3) add(` … ${listed.length - 3} more open`, 'muted')
  }
  if (data.pending) add(`review  ${data.pending} pending · hafiz review`, 'warning')
  for (const n of [...data.notices].reverse().slice(0, 3))
    add(`! ${n.text}`, n.level === 'warn' ? 'warning' : 'muted')
  const c = data.counters ?? {}
  const emits = c.view_emits ?? 0
  const cond = (c.condense_tokens_in ?? 0) + (c.condense_tokens_out ?? 0)
  if (data.role)
    add(`cost  ${emits} re-emit${emits === 1 ? '' : 's'} · cond ${compact(cond)} tok`, 'muted')
  return out
}

/** `◆ <first focus block> · N pending` for the prompt's right side; empty without a tree. */
export function statusChip(data: Pick<SidebarData, 'nodes' | 'focus' | 'pending' | 'project'>) {
  if (data.nodes.length === 0) return ''
  const byId = new Map(data.nodes.map((n) => [n.id, n]))
  const first = data.focus.map((id) => byId.get(id)).find(Boolean)
  const more = first && data.focus.length > 1 ? ` +${data.focus.length - 1}` : ''
  const label = clip(first?.title ?? data.project, 24)
  return `◆ ${label}${more}${data.pending ? ` · ${data.pending} pending` : ''}`
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
  add(`accept/reject with: hafiz review --accept ${p.id}`, 'warning')
  return out
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
