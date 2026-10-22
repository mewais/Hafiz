// The review table (`policies.yaml review`, §7) as pure functions: which row a proposal falls
// under, which design/plan reviews are open on a block, which of them hold it, who approves.
import type { ReviewPolicy } from '../config/schema.js'
import {
  type Block,
  type BlockId,
  type Proposal,
  REVIEW_TYPES,
  type ReviewMode,
  type ReviewType,
} from './types.js'

/** An open design/plan review on a block: pending, or rejected and not yet revised. */
export interface ReviewState {
  /** The proposal id (`hafiz review --accept <id>`). */
  proposal: string
  /** The doc version under review. */
  version: number
  status: 'pending' | 'rejected'
  note?: string
  /** The reviewer's note on a rejection. */
  resolutionNote?: string
}

export type BlockReviews = Partial<Record<ReviewType, ReviewState>>

const isReviewType = (k: string): k is ReviewType => (REVIEW_TYPES as readonly string[]).includes(k)

/** The table row a proposal falls under; compliance proposals are not in the table (`queue`). */
export function reviewModeOf(
  policy: ReviewPolicy,
  p: Pick<Proposal, 'kind' | 'source'>,
): ReviewMode {
  if (p.source === 'review' && isReviewType(p.kind)) return policy[p.kind]
  if (p.source === 'auto_done') return policy.done
  if (p.source === 'condenser' || p.source === 'drafter') return policy.drafts
  return 'queue'
}

/** The doc version a review proposal is for. */
export const reviewVersion = (p: Pick<Proposal, 'payload'>): number =>
  Number(p.payload.args.version ?? 0)

/**
 * Open reviews per block: the latest review proposal of each block and doc type (the pending
 * one, else the highest version), if it is pending, or rejected for the doc's current version (a
 * rejection holds until a new version is filed). Accepted reviews are closed.
 */
export function reviewStates(
  blocks: readonly Block[],
  proposals: readonly Proposal[],
): Map<BlockId, BlockReviews> {
  const later = (a: Proposal, b: Proposal) =>
    (a.status === 'pending') !== (b.status === 'pending')
      ? a.status === 'pending'
      : reviewVersion(a) !== reviewVersion(b)
        ? reviewVersion(a) > reviewVersion(b)
        : a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
  const latest = new Map<string, Proposal>()
  for (const p of proposals) {
    if (p.source !== 'review' || !p.blockId || !isReviewType(p.kind)) continue
    const key = `${p.blockId}/${p.kind}`
    const cur = latest.get(key)
    if (!cur || later(p, cur)) latest.set(key, p)
  }
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const out = new Map<BlockId, BlockReviews>()
  for (const p of latest.values()) {
    const b = byId.get(p.blockId as BlockId)
    const type = p.kind as ReviewType
    if (!b || p.status === 'accepted') continue
    const version = reviewVersion(p)
    if (p.status === 'rejected' && version !== b.docVersions[type]) continue
    out.set(b.id, {
      ...out.get(b.id),
      [type]: {
        proposal: p.id,
        version,
        status: p.status,
        ...(p.note ? { note: p.note } : {}),
        ...(p.resolutionNote ? { resolutionNote: p.resolutionNote } : {}),
      },
    })
  }
  return out
}

/** The first open review whose row is `gate` (design before plan): what holds the block. */
export function gatingReview(
  policy: ReviewPolicy,
  reviews: BlockReviews | undefined,
): { type: ReviewType; review: ReviewState } | undefined {
  for (const type of REVIEW_TYPES) {
    const review = reviews?.[type]
    if (review && policy[type] === 'gate') return { type, review }
  }
  return undefined
}

/** May `role` accept or reject design/plan reviews? The user always; `approver` too. */
export const mayApprove = (policy: ReviewPolicy, role: string): boolean =>
  role === 'user' || role === policy.approver
