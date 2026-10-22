// Design and plan reviews (§7, `policies.yaml review`): filing a proposal when a doc is ready for
// review, pinning the approved version, and the reads the CLI and the TUI share (list, show).
// Filing is Hafiz's own bookkeeping (system writes); resolving goes through proposals.ts.

import type { DocSchema } from '../config/schema.js'
import { NotFoundError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import { mayApprove, reviewModeOf, reviewVersion } from '../domain/review.js'
import {
  type Actor,
  type Block,
  type BlockId,
  type Doc,
  type DocType,
  type Proposal,
  REVIEW_TYPES,
  type ReviewMode,
  type ReviewType,
  type SectionValue,
  type StructuredInterface,
} from '../domain/types.js'
import { schemaFor } from '../schema/validate.js'
import { suggestedCommand } from '../session/review.js'
import type { ReadOps, WriteOps } from '../store/backend.js'
import { renderDoc } from '../view/render.js'
import { authorize } from './authz.js'
import { type CoreContext, mustBlock, progressEntry, runSystem } from './tx.js'

// ───────────────────────────── changed-since note ─────────────────────────────

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** `+2 provides, -1 consumes` for an interface section; empty when the names did not change. */
function interfaceDelta(old: SectionValue | undefined, cur: SectionValue | undefined): string {
  const o = (old ?? {}) as StructuredInterface
  const c = (cur ?? {}) as StructuredInterface
  const parts: string[] = []
  for (const key of ['provides', 'consumes'] as const) {
    const before = new Set((o[key] ?? []).map((x) => x.name))
    const after = new Set((c[key] ?? []).map((x) => x.name))
    const added = [...after].filter((n) => !before.has(n)).length
    const removed = [...before].filter((n) => !after.has(n)).length
    if (added) parts.push(`+${added} ${key}`)
    if (removed) parts.push(`-${removed} ${key}`)
  }
  return parts.join(', ')
}

/**
 * One line naming what changed between two versions of a doc: the sections (schema order) and,
 * for interface sections, how many provides/consumes were added or removed.
 * `changed since v1: scope, interface (+1 provides)`; `new: purpose, scope, interface (+2 provides)`.
 */
export function changedSince(
  schema: DocSchema | undefined,
  old: Pick<Doc, 'version' | 'sections'> | null,
  cur: Pick<Doc, 'sections'>,
): string {
  const known = schema?.sections.map((s) => s.name) ?? []
  const names = [...new Set([...Object.keys(old?.sections ?? {}), ...Object.keys(cur.sections)])]
  const ordered = [
    ...known.filter((n) => names.includes(n)),
    ...names.filter((n) => !known.includes(n)).sort(),
  ]
  const structured = new Set(
    schema?.sections.filter((s) => s.format === 'structured').map((s) => s.name),
  )
  const changed = ordered
    .filter((n) => !same(old?.sections[n], cur.sections[n]))
    .map((n) => {
      const d = structured.has(n) ? interfaceDelta(old?.sections[n], cur.sections[n]) : ''
      const gone = old && n in old.sections && !(n in cur.sections) ? ' removed' : ''
      return `${n}${gone}${d ? ` (${d})` : ''}`
    })
  if (!old) return `new: ${changed.join(', ') || 'empty'}`
  return changed.length
    ? `changed since v${old.version}: ${changed.join(', ')}`
    : `no section changed since v${old.version}`
}

/** A doc as it was at `version`: the current doc, or the version history (git / versions table). */
export async function docAtVersion(
  read: ReadOps,
  block: BlockId,
  type: DocType,
  version: number,
): Promise<Doc | null> {
  const cur = await read.getDoc(block, type)
  if (!cur || cur.version === version) return cur
  for (const h of await read.history(block, type)) {
    const d = await read.docAt(block, type, h.commit)
    if (d?.version === version) return d
    if (d && d.version < version) break // history is newest first
  }
  return null
}

// ───────────────────────────── filing ─────────────────────────────

const docKey = (b: BlockId, type: ReviewType) => `${b}/${type}`

/**
 * File (or refresh) the review of a block's design or plan, if its table row is not `off` and
 * its current version is newer than the approved one. One pending proposal per block and doc:
 * a newer version replaces the pending one's payload and note instead of stacking. Idempotent.
 */
export async function fileReview(
  ctx: CoreContext,
  by: Actor,
  blockId: BlockId,
  type: ReviewType,
): Promise<Proposal | null> {
  if (ctx.config.policies.review[type] === 'off') return null
  const read = ctx.backend.read
  const b = await read.getBlock(blockId)
  const version = b?.docVersions[type] ?? 0
  if (!b || !version || version <= (b.reviewed?.[type] ?? 0)) return null
  const filed = (await read.listProposals()).filter(
    (p) => p.source === 'review' && p.blockId === b.id && p.kind === type,
  )
  // This version is already pending, or was rejected (a rejection stands until a new version).
  if (filed.some((p) => p.status !== 'accepted' && reviewVersion(p) === version)) return null
  const pending = filed.find((p) => p.status === 'pending')
  const cur = await read.getDoc(b.id, type)
  if (!cur) return null
  const base = b.reviewed?.[type] ?? 0
  const old = base ? await docAtVersion(read, b.id, type, base) : null
  const what =
    base && !old
      ? `changes since v${base} unknown (no history)`
      : changedSince(schemaFor(ctx.config, b.kind, type), old, cur)
  const note = `${type} v${version} of '${b.title}': ${what}`
  const payload = { command: 'review.approve', args: { block: b.id, type, version } }
  const spec = { command: 'review.file', major: false, target: docKey(b.id, type) }
  const { result } = await runSystem(ctx, by, spec, async (t) => {
    const p: Proposal = pending
      ? { ...pending, payload, note }
      : {
          id: opaqueId('prop'),
          kind: type,
          source: 'review',
          blockId: b.id,
          payload,
          note,
          status: 'pending',
          createdAt: ctx.clock.now(),
        }
    await t.putProposal(p)
    return p
  })
  return result
}

/** Docs written by roles that do not approve reviews are filed; the approvers' own are not. */
const filesFor = (ctx: CoreContext, role: string) => !mayApprove(ctx.config.policies.review, role)

/**
 * `block.create` with an inline design or plan, by a role that does not approve reviews: file
 * them now (the session-end path would miss a block created and finished in one call).
 */
export async function fileCreated(
  ctx: CoreContext,
  by: Actor,
  block: BlockId,
  types: readonly ReviewType[],
): Promise<Proposal[]> {
  if (!filesFor(ctx, by.role)) return []
  const out: Proposal[] = []
  for (const type of types) {
    const p = await fileReview(ctx, by, block, type)
    if (p) out.push(p)
  }
  return out
}

/** A session ends: file every design and plan whose current version it wrote. */
export async function fileSessionReviews(ctx: CoreContext, sessionId: string): Promise<Proposal[]> {
  // `backend.read` afresh each time: filing commits, and a held reader may predate it.
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s || !filesFor(ctx, s.role)) return []
  const by: Actor = { sessionId: s.id, role: s.role, ...(s.agent ? { agent: s.agent } : {}) }
  const out: Proposal[] = []
  for (const b of await ctx.backend.read.listBlocks())
    for (const type of REVIEW_TYPES) {
      if (ctx.config.policies.review[type] === 'off') continue
      if (b.docVersions[type] <= (b.reviewed?.[type] ?? 0)) continue
      const doc = await ctx.backend.read.getDoc(b.id, type)
      if (doc?.by.sessionId !== s.id) continue
      const p = await fileReview(ctx, by, b.id, type)
      if (p) out.push(p)
    }
  return out
}

// ───────────────────────────── approval ─────────────────────────────

/**
 * Accepting a review, inside the accepting transaction: pin the approved version on the block and
 * note it in the progress log (`changed`; Hafiz never records decisions). Returns the block.
 */
export async function pinReview(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  p: Proposal,
): Promise<Block> {
  const type = p.kind as ReviewType
  const version = reviewVersion(p)
  const b = await mustBlock(t, p.blockId as BlockId)
  const nb: Block = {
    ...b,
    reviewed: { ...b.reviewed, [type]: Math.max(version, b.reviewed?.[type] ?? 0) },
    version: b.version + 1,
    updatedAt: ctx.clock.now(),
  }
  await t.putBlock(nb, b.version)
  await t.appendLog(
    b.id,
    'progress',
    progressEntry(ctx, by, b.id, 'changed', { text: `${type} v${version} approved by ${by.role}` }),
  )
  return nb
}

// ───────────────────────────── reads ─────────────────────────────

/** A proposal as the review queue lists it: its table row, block and (design/plan) version. */
export interface ReviewItem extends Proposal {
  /** `policies.yaml review` row: `gate` holds the block until accepted. */
  mode: ReviewMode
  blockTitle?: string
  /** Design/plan reviews: the doc version under review. */
  version?: number
}

export async function reviewList(
  ctx: CoreContext,
  by: Actor,
  status: Proposal['status'] | 'all' = 'pending',
): Promise<ReviewItem[]> {
  authorize(ctx.config, by.role, 'proposal.list')
  const read = ctx.backend.read
  const titles = new Map((await read.listBlocks()).map((b) => [b.id, b.title]))
  const policy = ctx.config.policies.review
  return (await read.listProposals(status === 'all' ? undefined : { status })).map((p) => {
    const title = p.blockId ? titles.get(p.blockId) : undefined
    return {
      ...p,
      mode: reviewModeOf(policy, p),
      ...(title !== undefined ? { blockTitle: title } : {}),
      ...(p.source === 'review' ? { version: reviewVersion(p) } : {}),
    }
  })
}

/** What `hafiz review --show` prints: the doc a review is about, at the version under review. */
export interface ReviewShow {
  item: ReviewItem
  /** The doc at the reviewed version; null when the history no longer has it. */
  doc: Doc | null
  /** The doc rendered as labelled sections. */
  text: string
}

/**
 * A proposal and what accepting it is about: for design/plan reviews the doc at the reviewed
 * version; for other proposals the doc their command would write, else the command.
 */
export async function reviewShow(ctx: CoreContext, by: Actor, id: string): Promise<ReviewShow> {
  const item = (await reviewList(ctx, by, 'all')).find((p) => p.id === id)
  if (!item) throw new NotFoundError('proposal', id)
  const read = ctx.backend.read
  if (item.source === 'review') {
    const b = await mustBlock(read, item.blockId as BlockId)
    const type = item.kind as ReviewType
    const doc = await docAtVersion(read, b.id, type, item.version ?? 0)
    const text = doc
      ? renderDoc(ctx.config, b.kind, doc)
      : `${type} v${item.version} is no longer in the history (current: v${b.docVersions[type]})`
    return { item, doc, text }
  }
  // Any other proposal: the doc its command would write, else the command itself.
  const args = item.payload.args
  const sections = args.sections ?? args.digest
  if (sections && typeof sections === 'object' && item.blockId) {
    const b = await mustBlock(read, item.blockId)
    const type = (typeof args.type === 'string' ? args.type : 'digest') as DocType
    const doc = { type, sections: sections as Doc['sections'] }
    return { item, doc: null, text: renderDoc(ctx.config, b.kind, doc) }
  }
  return { item, doc: null, text: suggestedCommand(item) }
}
