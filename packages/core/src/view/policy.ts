// View policy: view inheritance, rule matching, zoom order and selector parsing. Pure.
import type { Config, DegradeStep, MatchClause, ViewRule } from '../config/schema.js'
import { ValidationError } from '../domain/errors.js'

/** Attributes Relate computes for a block relative to one focus block. Open-ended by design. */
export type Attrs = Readonly<Record<string, string | number | boolean | undefined>>

export interface Budget {
  share_of_window: number
  min_tokens: number
  max_tokens: number
}

export interface ResolvedView {
  name: string
  /** The extends chain, most specific first (e.g. ['worker', 'default']). */
  chain: string[]
  budget: Budget
  dependencyDepth: number
  rules: ViewRule[]
  degrade: DegradeStep[]
}

const DEFAULT_BUDGET: Budget = { share_of_window: 0.3, min_tokens: 3000, max_tokens: 24000 }

/** Resolve `extends`, `rules_prepend` and partial `budget` overrides into a flat view. */
export function resolveView(config: Config, name: string): ResolvedView {
  const views = config.views.views
  const chain: string[] = []
  for (let n: string | undefined = name; n; n = views[n]?.extends) {
    if (chain.includes(n)) throw new ValidationError(`view '${name}': extends cycle via '${n}'`)
    if (!views[n]) throw new ValidationError(`unknown view '${n}'`)
    chain.push(n)
  }
  let budget = DEFAULT_BUDGET
  let dependencyDepth = 2
  let rules: ViewRule[] = []
  let degrade: DegradeStep[] = []
  for (const n of [...chain].reverse()) {
    const v = views[n] as NonNullable<(typeof views)[string]>
    budget = { ...budget, ...(stripUndefined(v.budget ?? {}) as Partial<Budget>) }
    if (v.dependency_depth !== undefined) dependencyDepth = v.dependency_depth
    if (v.rules) rules = v.rules
    if (v.rules_prepend) rules = [...v.rules_prepend, ...rules]
    if (v.degrade) degrade = v.degrade
  }
  return { name, chain, budget, dependencyDepth, rules, degrade }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** Every key in the clause must match; a list value matches any of its members. */
export function matches(clause: MatchClause, attrs: Attrs): boolean {
  for (const [k, want] of Object.entries(clause)) {
    const have = attrs[k]
    if (have === undefined) return false
    const options = Array.isArray(want) ? want : [want]
    if (!options.some((w) => String(w) === String(have))) return false
  }
  return true
}

export function formatClause(clause: MatchClause): string {
  const parts = Object.entries(clause).map(
    ([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`,
  )
  return `{ ${parts.join(', ')} }`
}

export interface RuleHit {
  /** 1-based position in the resolved rule list; 0 = no rule matched (fell through to NONE). */
  index: number
  zoom: string
  floor?: string
  label: string
}

/** First matching rule wins. */
export function applyRules(rules: readonly ViewRule[], attrs: Attrs, fallback: string): RuleHit {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] as ViewRule
    if ('default' in r) return { index: i + 1, zoom: r.default, label: `default: ${r.default}` }
    if (matches(r.match, attrs))
      return {
        index: i + 1,
        zoom: r.zoom,
        ...(r.floor ? { floor: r.floor } : {}),
        label: `${formatClause(r.match)} → ${r.zoom}${r.floor ? ` (floor ${r.floor})` : ''}`,
      }
  }
  return { index: 0, zoom: fallback, label: `no rule matched → ${fallback}` }
}

/** Zoom levels ordered most → least detailed (key order of `zooms.yaml`). */
export class ZoomOrder {
  readonly names: readonly string[]
  constructor(config: Config) {
    this.names = Object.keys(config.zooms.zooms)
    if (!this.names.length) throw new ValidationError('zooms.yaml defines no zoom levels')
  }
  rank(z: string): number {
    const i = this.names.indexOf(z)
    if (i < 0) throw new ValidationError(`unknown zoom '${z}'. Known: ${this.names.join(', ')}`)
    return i
  }
  /** The most detailed of the given zooms. */
  max(...zs: string[]): string {
    return zs.reduce((a, b) => (this.rank(b) < this.rank(a) ? b : a))
  }
  /** The least detailed of the given zooms. */
  min(...zs: string[]): string {
    return zs.reduce((a, b) => (this.rank(b) > this.rank(a) ? b : a))
  }
  get least(): string {
    return this.names[this.names.length - 1] as string
  }
  validate(config: Config, view: ResolvedView): void {
    for (const r of view.rules) {
      this.rank('default' in r ? r.default : r.zoom)
      if (!('default' in r) && r.floor) this.rank(r.floor)
    }
    for (const s of view.degrade) if (s.to) this.rank(s.to)
    for (const sels of Object.values(config.zooms.zooms)) for (const s of sels) parseSelector(s)
    for (const f of config.zooms.floor) for (const s of f.sections) parseSelector(s)
  }
}

// ───────────────────────────── selectors ─────────────────────────────

export type Selector =
  | { kind: 'block.header' }
  | { kind: 'block.line' }
  | { kind: 'status.line' }
  | { kind: 'doc'; doc: string; section: string | '*' }
  | { kind: 'decisions.active'; last: number }
  | { kind: 'decisions.standing' }
  | { kind: 'progress'; last: number }
  | { kind: 'threads.open' }
  | { kind: 'threads.parked.titles' }

/** Trim keys (degrade `trim:`) → the list selectors they bound. */
export const TRIM_KEYS: Readonly<Record<string, Selector['kind']>> = {
  progress: 'progress',
  decisions: 'decisions.active',
}

const LAST_N = /^(decisions\.active|progress)\[-(\d+):\]$/

const cache = new Map<string, Selector>()

export function parseSelector(s: string): Selector {
  const hit = cache.get(s)
  if (hit) return hit
  const sel = parse(s)
  cache.set(s, sel)
  return sel
}

function parse(s: string): Selector {
  switch (s) {
    case 'block.header':
    case 'block.line':
    case 'status.line':
    case 'decisions.standing':
    case 'threads.open':
    case 'threads.parked.titles':
      return { kind: s }
  }
  const m = LAST_N.exec(s)
  if (m) return { kind: m[1] as 'progress' | 'decisions.active', last: Number(m[2]) }
  const d = /^(design|plan|digest)\.(\*|[a-z][a-z0-9_]*)$/.exec(s)
  if (d) return { kind: 'doc', doc: d[1] as string, section: d[2] as string }
  throw new ValidationError(`unknown view selector '${s}'`)
}
