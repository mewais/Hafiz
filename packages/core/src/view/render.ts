// Render: zoom → section selectors → Markdown. Pure and deterministic.
import type { Config, DocSchema } from '../config/schema.js'
import type {
  Block,
  Contract,
  DecisionView,
  DocType,
  Ref,
  SectionValue,
  StructuredInterface,
} from '../domain/types.js'
import { parseSelector, type Selector, TRIM_KEYS } from './policy.js'
import type { BlockSnap, FoldedStep, Snapshot } from './snapshot.js'

export interface RenderCtx {
  config: Config
  snap: Snapshot
}

export interface BlockRenderOpts {
  zoom: string
  /** Per-family caps from degrade `trim:` steps, e.g. { progress: 3, decisions: 2 }. */
  trim?: Readonly<Record<string, number>>
  /** Short markers appended to the heading (e.g. `focus`). */
  marks?: readonly string[]
  /** Heading level; defaults to tree depth + 1 (capped at 6). */
  level?: number
}

const STEP_BOX: Record<FoldedStep['status'], string> = {
  todo: '[ ]',
  doing: '[~]',
  done: '[x]',
  skipped: '[-]',
}

export function sectionLabel(name: string): string {
  const s = name.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

function schemaOf(config: Config, kind: string, type: string): DocSchema | undefined {
  const k = config.kinds.kinds[kind] ?? config.kinds.kinds[config.kinds.default_kind]
  const name = k?.schemas[type]
  return name ? config.schemas[name] : undefined
}

/** Section names of a doc in schema order, then any unknown sections alphabetically. */
function sectionOrder(schema: DocSchema | undefined, sections: Record<string, SectionValue>) {
  const known = schema?.sections.map((s) => s.name) ?? []
  const extra = Object.keys(sections)
    .filter((n) => !known.includes(n))
    .sort()
  return [...known.filter((n) => n in sections), ...extra]
}

function inferFormat(v: SectionValue): string {
  if (typeof v === 'string') return 'prose'
  if (!Array.isArray(v)) return 'structured'
  const first = v[0] as unknown
  if (first && typeof first === 'object') {
    if ('ref' in first) return 'refs'
    if ('id' in first && 'title' in first) return 'steps'
  }
  return 'list'
}

function contractLine(verb: string, c: Contract): string {
  return `- ${verb} \`${c.name}\`${c.type ? ` (${c.type})` : ''}${c.notes ? ` — ${oneLine(c.notes)}` : ''}`
}

function refsLine(refs: readonly Ref[]): string {
  return refs.map((r) => (r.label === r.ref ? r.ref : `${r.label} (${r.ref})`)).join('; ')
}

function stepLines(steps: readonly FoldedStep[]): string[] {
  return steps.map(
    (s) =>
      `- ${STEP_BOX[s.status]} ${s.id} ${oneLine(s.title)}${s.notes ? ` — ${oneLine(s.notes)}` : ''}`,
  )
}

/** Format one section value by its schema format. Returns '' for empty values. */
export function formatSection(
  name: string,
  format: string,
  value: SectionValue,
  steps?: readonly FoldedStep[],
): string {
  const head = sectionLabel(name)
  switch (format) {
    case 'prose': {
      const t = String(value).trim()
      if (!t) return ''
      return t.includes('\n') ? `${head}:\n${t}` : `${head}: ${t}`
    }
    case 'list': {
      const items = (value as string[]).map((x) => oneLine(String(x))).filter(Boolean)
      if (!items.length) return ''
      if (items.length === 1) return `${head}: ${items[0]}`
      return [`${head}:`, ...items.map((x) => `- ${x}`)].join('\n')
    }
    case 'refs': {
      const refs = value as Ref[]
      return refs.length ? `${head}: ${refsLine(refs)}` : ''
    }
    case 'steps': {
      const folded =
        steps ?? (value as FoldedStep[]).map((s) => ({ ...s, status: s.status ?? 'todo' }))
      return folded.length ? [`${head}:`, ...stepLines(folded)].join('\n') : ''
    }
    case 'structured': {
      const v = value as StructuredInterface
      const lines = [
        ...(v.provides ?? []).map((c) => contractLine('provides', c)),
        ...(v.consumes ?? []).map((c) => contractLine('consumes', c)),
        ...(v.contracts ?? []).map((c) => contractLine('contract', c)),
      ]
      return lines.length ? [`${head}:`, ...lines].join('\n') : ''
    }
    default:
      return formatSection(name, inferFormat(value), value, steps)
  }
}

export function decisionLine(d: DecisionView): string {
  const why = d.rationale ? ` Why: ${oneLine(d.rationale)}` : ''
  return `- ${oneLine(d.title)}: ${oneLine(d.decision)}${why} \`${d.id}\``
}

/** `- Never log card numbers. (payments · dec-7)`; the standing word is prefixed unless the text leads with it. */
export function standingLine(d: DecisionView, where?: string): string {
  const text = oneLine(d.decision)
  const lead =
    d.standing && !text.toLowerCase().startsWith(d.standing) ? `${sectionLabel(d.standing)}: ` : ''
  return `- ${lead}${text} (${where ? `${where} · ` : ''}${d.id})`
}

export const activeDecisions = (s: BlockSnap) =>
  s.decisions.filter((d) => d.status === 'active' && !d.standing)
export const standingDecisions = (s: BlockSnap) =>
  s.decisions.filter((d) => d.status === 'active' && !!d.standing)

export function headingLine(
  ctx: RenderCtx,
  b: Block,
  level: number,
  marks: readonly string[] = [],
): string {
  const kind =
    b.kind !== ctx.config.kinds.default_kind && b.kind !== 'root' && b.parentId !== null
      ? [b.kind]
      : []
  const tags = [b.status, ...kind, ...marks].join(' · ')
  return `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${oneLine(b.title)} [${b.id}] ${tags}`
}

function headerMeta(ctx: RenderCtx, s: BlockSnap): string {
  const b = s.block
  const parts: string[] = []
  if (b.blockedOn) {
    const bo = b.blockedOn
    parts.push(
      `Blocked on: ${bo.kind}${bo.ref ? ` ${bo.ref}` : ''}${bo.note ? ` — ${oneLine(bo.note)}` : ''}`,
    )
  }
  const deps = ctx.snap.dependsOn.get(b.id) ?? []
  if (deps.length) parts.push(`Depends on: ${deps.join(', ')}`)
  if (b.digestStale) parts.push('Digest stale (reopened)')
  return parts.join(' · ')
}

function statusLine(s: BlockSnap): string {
  const parts: string[] = []
  if (s.steps.length) {
    const done = s.steps.filter((x) => x.status === 'done' || x.status === 'skipped').length
    parts.push(`${done}/${s.steps.length} steps done`)
    const doing = s.steps.find((x) => x.status === 'doing')
    if (doing) parts.push(`doing ${doing.id} ${oneLine(doing.title)}`)
  }
  const open = s.threads.filter((t) => t.status === 'open').length
  if (open) parts.push(`${open} open thread${open === 1 ? '' : 's'}`)
  return parts.length ? `Status: ${parts.join(' · ')}` : ''
}

function cap(n: number, trim: Readonly<Record<string, number>> | undefined, kind: string) {
  for (const [k, fam] of Object.entries(TRIM_KEYS))
    if (fam === kind && trim?.[k] !== undefined) return Math.min(n, trim[k] as number)
  return n
}

function renderDocSelector(
  ctx: RenderCtx,
  s: BlockSnap,
  doc: string,
  section: string,
  seen: Set<string>,
): string[] {
  const d = s.docs[doc as DocType]
  if (!d) return []
  const schema = schemaOf(ctx.config, s.block.kind, doc)
  const names = section === '*' ? sectionOrder(schema, d.sections) : [section]
  const out: string[] = []
  for (const name of names) {
    const key = `${doc}.${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const value = d.sections[name]
    if (value === undefined) continue
    const format = schema?.sections.find((x) => x.name === name)?.format ?? inferFormat(value)
    const text = formatSection(name, format, value, format === 'steps' ? s.steps : undefined)
    if (text) out.push(text)
  }
  return out
}

function renderSelector(
  ctx: RenderCtx,
  s: BlockSnap,
  sel: Selector,
  trim: BlockRenderOpts['trim'],
  seen: Set<string>,
): string[] {
  switch (sel.kind) {
    case 'block.header':
    case 'block.line':
      return [] // the heading is always emitted; header meta is handled by the caller
    case 'status.line': {
      const l = statusLine(s)
      return l ? [l] : []
    }
    case 'doc':
      return renderDocSelector(ctx, s, sel.doc, sel.section, seen)
    case 'decisions.active': {
      const n = cap(sel.last, trim, sel.kind)
      const ds = n > 0 ? activeDecisions(s).slice(-n).reverse() : []
      return ds.length ? [['Decisions:', ...ds.map(decisionLine)].join('\n')] : []
    }
    case 'decisions.standing': {
      const ds = standingDecisions(s)
      return ds.length ? [['Standing:', ...ds.map((d) => standingLine(d))].join('\n')] : []
    }
    case 'progress': {
      const n = cap(sel.last, trim, sel.kind)
      const ps = n > 0 ? s.progress.slice(-n) : []
      if (!ps.length) return []
      return [
        [
          'Progress:',
          ...ps.map(
            (p) =>
              `- ${p.kind}: ${oneLine(p.text)}${p.refs.length ? ` [${p.refs.join(', ')}]` : ''}`,
          ),
        ].join('\n'),
      ]
    }
    case 'threads.open': {
      const ts = s.threads.filter((t) => t.status === 'open')
      if (!ts.length) return []
      return [
        [
          'Open threads:',
          ...ts.map((t) => {
            const last = t.entries[t.entries.length - 1]?.text ?? t.gist
            return `- ${oneLine(t.title)} \`${t.id}\`${last ? `: ${oneLine(last)}` : ''}`
          }),
        ].join('\n'),
      ]
    }
    case 'threads.parked.titles': {
      const ts = s.threads.filter((t) => t.status === 'parked')
      return ts.length
        ? [`Parked threads: ${ts.map((t) => `${oneLine(t.title)} \`${t.id}\``).join('; ')}`]
        : []
    }
  }
}

/** Render one block at a zoom. Returns '' when the zoom selects nothing. */
export function renderBlock(ctx: RenderCtx, id: string, opts: BlockRenderOpts): string {
  const s = ctx.snap.blocks.get(id)
  if (!s) return ''
  const selectors = (ctx.config.zooms.zooms[opts.zoom] ?? []).map(parseSelector)
  if (!selectors.length) return ''
  const level = opts.level ?? (ctx.snap.depth.get(id) ?? 0) + 1
  const lines = [headingLine(ctx, s.block, level, opts.marks)]
  if (selectors.some((x) => x.kind === 'block.header')) {
    const meta = headerMeta(ctx, s)
    if (meta) lines.push(meta)
  }
  const seen = new Set<string>()
  for (const sel of selectors) lines.push(...renderSelector(ctx, s, sel, opts.trim, seen))
  return lines.join('\n')
}

/** Render selectors for a block without its heading (used by the floor for non-decision selectors). */
export function renderSections(ctx: RenderCtx, id: string, selectors: readonly string[]): string[] {
  const s = ctx.snap.blocks.get(id)
  if (!s) return []
  const seen = new Set<string>()
  return selectors.flatMap((x) => renderSelector(ctx, s, parseSelector(x), undefined, seen))
}
