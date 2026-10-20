// The view engine: Relate → Policy → Render → Degrade → Floor → Hash. Pure over a Snapshot.
// See docs/ARCHITECTURE.md §6.
import { createHash } from 'node:crypto'
import type { Config, DegradeStep } from '../config/schema.js'
import { ValidationError } from '../domain/errors.js'
import type { BlockId, Focus } from '../domain/types.js'
import type { Notice } from '../schema/validate.js'
import type { Tokenizer } from '../tokenizer.js'
import {
  type Attrs,
  applyRules,
  type Budget,
  formatClause,
  matches,
  parseSelector,
  type ResolvedView,
  type RuleHit,
  resolveView,
  ZoomOrder,
} from './policy.js'
import { attrsFor, RELATION_PRECEDENCE, type Relation, relateTo } from './relate.js'
import {
  headingLine,
  type RenderCtx,
  renderBlock,
  renderSections,
  standingDecisions,
  standingLine,
} from './render.js'
import type { Snapshot } from './snapshot.js'

export interface ViewOptions {
  role: string
  focus: Focus
  /** Overrides the role's view. */
  view?: string
  /** Model key into `hafiz.yaml windows`; falls back to `default`. */
  model?: string
  /** Explicit budget in tokens (skips the share/min/max computation). */
  budgetTokens?: number
}

export interface ManifestEntry {
  block: BlockId
  relation: Relation
  zoom: string
  tokens: number
}

export interface Evaluation {
  focus: BlockId | null
  attrs: Attrs
  hit: RuleHit
}

export interface DegradeEffect {
  /** 1-based index into the view's degrade list. */
  step: number
  label: string
  focus?: BlockId
  from?: string
  to?: string
  trim?: Record<string, number>
}

export interface BlockTrace {
  block: BlockId
  evaluations: Evaluation[]
  /** The evaluation whose zoom won the max-zoom aggregation. */
  winner: Evaluation
  zoom: string
  floor?: string
  effects: DegradeEffect[]
  /** Shown at the connector zoom only because a descendant is visible. */
  connector: boolean
  finalZoom: string
  tokens: number
}

export interface ViewResult {
  /** The envelope: `<hafiz hash="…" role="…">` … `</hafiz>`. */
  text: string
  hash: string
  /** Standing decisions, rendered separately; never degraded. '' when there are none. */
  floorText: string
  manifest: ManifestEntry[]
  notices: Notice[]
  budget: number
  tokens: number
  floorTokens: number
  view: ResolvedView
  trace: ReadonlyMap<BlockId, BlockTrace>
}

export function computeBudget(
  config: Config,
  budget: Budget,
  opts: { model?: string; budgetTokens?: number } = {},
): number {
  if (opts.budgetTokens !== undefined) return opts.budgetTokens
  const windows = config.hafiz.windows
  const window = (opts.model ? windows[opts.model] : undefined) ?? windows.default ?? 200000
  const raw = Math.round(budget.share_of_window * window)
  return Math.min(Math.max(raw, budget.min_tokens), budget.max_tokens)
}

export function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/** Focus blocks in priority order (highest first): `focus.order`, then the rest of `blocks`. */
export function focusPriority(focus: Focus, snap: Snapshot): BlockId[] {
  const valid = focus.blocks.filter((b) => snap.blocks.has(b))
  const ordered = (focus.order ?? []).filter((b) => valid.includes(b))
  return [...new Set([...ordered, ...valid])]
}

const relRank = (r: unknown) => RELATION_PRECEDENCE.indexOf(r as Relation)

function stepLabel(s: DegradeStep): string {
  const what = s.to ? `to ${s.to}` : `trim ${formatClause(s.trim ?? {}).replace(/^\{ | \}$/g, '')}`
  return `${formatClause(s.match)} ${what}${s.order ? ` (${s.order})` : ''}`
}

/** Blocks are separated by a blank line, except runs of heading-only blocks, which stay compact. */
function joinChunks(chunks: readonly string[]): string {
  let out = ''
  let prevSingle = false
  for (const c of chunks) {
    const single = !c.includes('\n')
    if (out) out += prevSingle && single ? '\n' : '\n\n'
    out += c
    prevSingle = single
  }
  return out
}

export function buildView(
  snap: Snapshot,
  config: Config,
  tok: Tokenizer,
  opts: ViewOptions,
): ViewResult {
  const role = config.roles.roles[opts.role]
  if (!role && !opts.view) throw new ValidationError(`unknown role '${opts.role}'`)
  const view = resolveView(config, opts.view ?? (role?.view as string))
  const zooms = new ZoomOrder(config)
  zooms.validate(config, view)
  const NONE = zooms.least
  const CONNECTOR = zooms.names[zooms.names.length - 2] ?? NONE
  const ctx: RenderCtx = { config, snap }
  const notices: Notice[] = []

  const missing = opts.focus.blocks.filter((b) => !snap.blocks.has(b))
  if (missing.length)
    notices.push({ level: 'warn', text: `focus block(s) not found: ${missing.join(', ')}` })
  const priority = focusPriority(opts.focus, snap)

  // ── Relate + Policy: evaluate rules per focus block, aggregate by max zoom ──
  const perFocus = new Map<BlockId | null, Map<BlockId, Attrs>>()
  for (const f of priority.length ? priority : [null]) {
    const rel = relateTo(snap, f, view.dependencyDepth)
    const attrs = new Map<BlockId, Attrs>()
    for (const [id, r] of rel) attrs.set(id, attrsFor(snap, id, r))
    perFocus.set(f, attrs)
  }
  const trace = new Map<BlockId, BlockTrace>()
  const zoom = new Map<BlockId, string>()
  for (const id of snap.treeOrder) {
    const evaluations: Evaluation[] = []
    for (const [f, attrs] of perFocus) {
      const a = attrs.get(id) as Attrs
      evaluations.push({ focus: f, attrs: a, hit: applyRules(view.rules, a, NONE) })
    }
    // most detailed zoom wins; ties → relation precedence, then focus priority (stable)
    const winner = evaluations.reduce((best, e) => {
      const d = zooms.rank(e.hit.zoom) - zooms.rank(best.hit.zoom)
      if (d !== 0) return d < 0 ? e : best
      return relRank(e.attrs.relation) < relRank(best.attrs.relation) ? e : best
    })
    const floors = evaluations.flatMap((e) => (e.hit.floor ? [e.hit.floor] : []))
    const floor = floors.length ? zooms.max(...floors) : undefined
    zoom.set(id, winner.hit.zoom)
    trace.set(id, {
      block: id,
      evaluations,
      winner,
      zoom: winner.hit.zoom,
      ...(floor ? { floor } : {}),
      effects: [],
      connector: false,
      finalZoom: winner.hit.zoom,
      tokens: 0,
    })
  }
  const winnerAttrs = (id: BlockId) => (trace.get(id) as BlockTrace).winner.attrs
  const trims = new Map<BlockId, Record<string, number>>()

  // ── Render ──
  /** Ancestors of visible blocks are shown at least at the connector zoom, so paths stay intact. */
  const effective = (): Map<BlockId, string> => {
    const eff = new Map(zoom)
    for (const id of [...snap.treeOrder].reverse()) {
      if (eff.get(id) === NONE) continue
      const parent = snap.blocks.get(id)?.block.parentId
      if (parent && eff.get(parent) === NONE) eff.set(parent, CONNECTOR)
    }
    return eff
  }
  const marksFor = (id: BlockId): string[] => {
    const r = winnerAttrs(id).relation
    return r === 'focus' || r === 'dependency' ? [r] : []
  }
  let chunks = new Map<BlockId, string>()
  let eff = new Map<BlockId, string>()
  const render = () => {
    eff = effective()
    chunks = new Map()
    for (const id of snap.treeOrder) {
      const z = eff.get(id) as string
      if (z === NONE) continue
      const trim = trims.get(id)
      const text = renderBlock(ctx, id, { zoom: z, marks: marksFor(id), ...(trim ? { trim } : {}) })
      if (text) chunks.set(id, text)
    }
    const body = joinChunks([...chunks.values()])
    return { body, tokens: tok.count(body) }
  }
  let { body, tokens } = render()

  // ── Degrade ──
  const budget = computeBudget(config, view.budget, opts)
  const applyStep = (step: DegradeStep, index: number, targets: BlockId[], focus?: BlockId) => {
    let changed = false
    for (const id of targets) {
      const t = trace.get(id) as BlockTrace
      const base: DegradeEffect = {
        step: index + 1,
        label: stepLabel(step),
        ...(focus ? { focus } : {}),
      }
      if (step.to) {
        const cur = zoom.get(id) as string
        let next = zooms.min(cur, step.to)
        if (t.floor) next = zooms.min(cur, zooms.max(next, t.floor))
        if (next !== cur) {
          zoom.set(id, next)
          t.effects.push({ ...base, from: cur, to: next })
          changed = true
        }
      }
      if (step.trim) {
        const cur = trims.get(id) ?? {}
        const next = { ...cur }
        for (const [k, v] of Object.entries(step.trim)) next[k] = Math.min(cur[k] ?? v, v)
        if (JSON.stringify(next) !== JSON.stringify(cur)) {
          trims.set(id, next)
          t.effects.push({ ...base, trim: step.trim })
          changed = true
        }
      }
    }
    if (changed) ({ body, tokens } = render())
  }
  view.degrade.forEach((step, i) => {
    if (tokens <= budget) return
    if (step.order === 'focus_reverse') {
      for (const f of [...priority].reverse()) {
        if (tokens <= budget) break
        const attrs = perFocus.get(f) as Map<BlockId, Attrs>
        const targets = snap.treeOrder.filter((id) => matches(step.match, attrs.get(id) as Attrs))
        applyStep(step, i, targets, f)
      }
    } else {
      const targets = snap.treeOrder.filter((id) => matches(step.match, winnerAttrs(id)))
      applyStep(step, i, targets)
    }
  })
  if (tokens > budget)
    notices.push({
      level: 'warn',
      text: `focus too wide: ${tokens - budget} tokens over budget; narrow focus or group under a parent block`,
    })

  // ── Floor ──
  const floorParts: string[] = []
  let floorTokens = 0
  for (const entry of config.zooms.floor) {
    const lines: string[] = []
    for (const id of snap.treeOrder) {
      const evals = (trace.get(id) as BlockTrace).evaluations
      if (!evals.some((e) => matches(entry.match, e.attrs))) continue
      const s = snap.blocks.get(id)
      if (!s) continue
      for (const raw of entry.sections) {
        const sel = parseSelector(raw)
        if (sel.kind === 'decisions.standing')
          lines.push(...standingDecisions(s).map((d) => standingLine(d, s.block.id)))
        else {
          const parts = renderSections(ctx, id, [raw])
          if (parts.length) lines.push(`${s.block.title} [${id}]:`, ...parts)
        }
      }
    }
    if (!lines.length) continue
    const text = lines.join('\n')
    const n = tok.count(text)
    floorTokens += n
    if (n > entry.cap)
      notices.push({
        level: 'warn',
        text: `standing decisions use ${n} tokens, over the floor cap of ${entry.cap}; consolidate standing decisions`,
      })
    floorParts.push(text)
  }
  const floorBody = floorParts.length
    ? `Standing decisions (always apply):\n${floorParts.join('\n')}`
    : ''

  // ── Manifest, hash, envelope ──
  const manifest: ManifestEntry[] = []
  for (const id of snap.treeOrder) {
    const t = trace.get(id) as BlockTrace
    const z = eff.get(id) as string
    t.finalZoom = z
    t.connector = zoom.get(id) === NONE && z !== NONE
    t.tokens = chunks.has(id) ? tok.count(chunks.get(id) as string) : 0
    if (z !== NONE)
      manifest.push({
        block: id,
        relation: t.winner.attrs.relation as Relation,
        zoom: z,
        tokens: t.tokens,
      })
  }
  const noticeLines = notices.map((n) => `> ${n.level}: ${n.text}`).join('\n')
  const inner = [onboardingDirective(snap, config, opts.role), noticeLines, body]
    .filter(Boolean)
    .join('\n\n')
  const hash = shortHash(`${inner}\n\u0000\n${floorBody}`)
  const text = `<hafiz hash="${hash}" role="${opts.role}">\n${inner}\n</hafiz>`
  const floorText = floorBody ? `<hafiz-floor>\n${floorBody}\n</hafiz-floor>` : ''
  return {
    text,
    hash,
    floorText,
    manifest,
    notices,
    budget,
    tokens,
    floorTokens,
    view,
    trace,
  }
}

// ───────────────────────────── explain ─────────────────────────────

/** `hafiz.yaml onboarding.directive` while a brownfield project's onboarding is pending. */
export function onboardingDirective(snap: Snapshot, config: Config, role: string): string {
  const o = config.hafiz.onboarding
  const p = snap.project
  if (p?.onboarding !== 'pending' || !o.directive || !o.roles.includes(role)) return ''
  return o.directive.trim().replace(/\{root\}/g, p.rootBlockId)
}

function fmtAttrs(a: Attrs): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

export interface Explanation {
  block: BlockId
  text: string
  trace: BlockTrace
}

/** Why a block renders the way it does: rule per focus block, aggregation, degrade steps. */
export function explain(result: ViewResult, snap: Snapshot, blockId: BlockId): Explanation {
  const t = result.trace.get(blockId)
  const b = snap.blocks.get(blockId)?.block
  if (!t || !b) throw new ValidationError(`block '${blockId}' is not in the tree`)
  const v = result.view
  const lines = [
    `explain ${b.id} "${b.title}" (${b.status}, ${b.kind})`,
    `view: ${v.chain.join(' → ')} · budget ${result.budget} · view ${result.tokens} tokens`,
    'rules (first match per focus block):',
    ...t.evaluations.map(
      (e) =>
        `  ${e.focus ? `focus ${e.focus}` : 'no focus'}: ${fmtAttrs(e.attrs)} → ${
          e.hit.index ? `rule ${e.hit.index} ${e.hit.label}` : e.hit.label
        }`,
    ),
    `aggregate (max zoom): ${t.zoom}${t.winner.focus ? ` via focus ${t.winner.focus}` : ''} as ${t.winner.attrs.relation}${t.floor ? ` · floor ${t.floor}` : ''}`,
  ]
  if (t.effects.length) {
    lines.push('degrade:')
    for (const e of t.effects)
      lines.push(
        `  step ${e.step} ${e.label}${e.focus ? ` [focus ${e.focus}]` : ''}: ${
          e.to ? `${e.from} → ${e.to}` : `trimmed ${formatClause(e.trim ?? {})}`
        }`,
      )
  } else lines.push('degrade: none applied')
  if (t.connector) lines.push(`shown at ${t.finalZoom}: a descendant is visible`)
  lines.push(`final: ${t.finalZoom} · ${t.tokens} tokens`)
  return { block: blockId, text: lines.join('\n'), trace: t }
}

/** Render a single block at a zoom, outside any view (for `block.read`). */
export function readBlock(snap: Snapshot, config: Config, id: BlockId, zoomName: string): string {
  const zooms = new ZoomOrder(config)
  zooms.rank(zoomName)
  const s = snap.blocks.get(id)
  if (!s) throw new ValidationError(`block '${id}' not found`)
  const ctx: RenderCtx = { config, snap }
  return renderBlock(ctx, id, { zoom: zoomName, level: 1 }) || headingLine(ctx, s.block, 1)
}
