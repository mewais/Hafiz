// The state table (§3.2, `policies.yaml spawn.roles_by_state`) as pure functions: is a block's
// design or plan in place for the next stage, which stage the block is in, and what to say when
// a doc is missing or held by its review. One predicate for every path that asks: the Kilo spawn
// check (host-kilo checks.ts) and Core's writes (a plan write needs the design, `done` needs the
// plan; commands/review.ts `requireDoc`), so their logic and texts cannot drift.
import type { Config, SpawnState } from '../config/schema.js'
import type { BlockReviews, ReviewState } from './review.js'
import { type DocType, REVIEW_TYPES, type ReviewType, type Status } from './types.js'

/** What the predicate reads of a block (a `Block` with `docs: docVersions`, or a tree node). */
export interface StageNode {
  title: string
  kind: string
  status: Status
  /** Doc versions; 0 or absent = not written. */
  docs: Partial<Record<DocType, number>>
}

/** The state a block is in while `type` is not in place. */
const MISSING: Record<ReviewType, SpawnState> = { design: 'no_design', plan: 'no_plan' }

/** Does the block's kind have a `type` document (`kinds.yaml` schemas)? */
export function kindDefines(config: Config, kind: string, type: DocType): boolean {
  const k = config.kinds.kinds[kind] ?? config.kinds.kinds[config.kinds.default_kind]
  return !!k?.schemas[type]
}

/** Why `type` is not in place: not written, or written and held by its open `gate` review. */
export interface NotReady {
  type: ReviewType
  held?: ReviewState
}

/**
 * Is `type` (design or plan) in place on the block? Written, when its kind defines it, and not
 * held: a doc whose `policies.yaml review` row is `gate` and whose review is open (pending, or
 * rejected and not yet revised) counts as not there yet. `reviews`: the block's open reviews
 * (`reviewStates`, or a `tree.summary` node's `review`); leave it out to ignore the gates (the
 * approver's own writes: it would accept them). Returns undefined when it is in place.
 */
export function notReady(
  config: Config,
  node: StageNode,
  type: ReviewType,
  reviews?: BlockReviews,
): NotReady | undefined {
  if (!kindDefines(config, node.kind, type)) return undefined
  if (!node.docs[type]) return { type }
  const held = reviews?.[type]
  return held && config.policies.review[type] === 'gate' ? { type, held } : undefined
}

/** The block's state in the spawn table: its status if closed, else its first doc not in place. */
export function stageOf(config: Config, node: StageNode, reviews?: BlockReviews): SpawnState {
  if (node.status === 'done' || node.status === 'dropped') return node.status
  for (const type of REVIEW_TYPES) if (notReady(config, node, type, reviews)) return MISSING[type]
  return 'has_plan'
}

/** The roles the spawn table first admits while `type` is missing: its writers. */
export function writersOf(config: Config, type: ReviewType): string[] {
  const table = config.policies.spawn.roles_by_state
  const i = REVIEW_TYPES.indexOf(type)
  const before = new Set(i > 0 ? (table[MISSING[REVIEW_TYPES[i - 1] as ReviewType]] ?? []) : [])
  return (table[MISSING[type]] ?? []).filter((r) => r !== '*' && !before.has(r))
}

/** A held review: "design of Payments (v3) awaits review: hafiz review --accept prop_…". */
export function heldSays(title: string, type: ReviewType, review: ReviewState): string {
  const doc = `${type} of ${title} (v${review.version})`
  if (review.status === 'pending')
    return `${doc} awaits review: hafiz review --accept ${review.proposal}`
  const why = review.resolutionNote ? `: ${review.resolutionNote}` : ''
  return `${doc} was rejected${why}; revise it (it is filed for review again)`
}

/** What a doc not in place says: the held review, or "Billing has no design yet; the designer writes it". */
export function notReadySays(config: Config, title: string, nr: NotReady): string {
  if (nr.held) return heldSays(title, nr.type, nr.held)
  const writers = writersOf(config, nr.type)
  return `${title} has no ${nr.type} yet${writers.length ? `; the ${writers.join(' or ')} writes it` : ''}`
}
