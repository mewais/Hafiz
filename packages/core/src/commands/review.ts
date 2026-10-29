// Design and plan reviews (§7, `policies.yaml review`): filing a proposal on every design/plan
// write, pinning the approved version, and the reads the CLI and the TUI share (list, show).
// Filing is Hafiz's own bookkeeping inside the write's transaction; resolving goes through
// proposals.ts.

import type { DocSchema } from '../config/schema.js'
import { NotFoundError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import { mayApprove, reviewModeOf, reviewVersion } from '../domain/review.js'
import type {
  Actor,
  Block,
  BlockId,
  Doc,
  DocType,
  Proposal,
  ReviewMode,
  ReviewType,
  SectionValue,
  StructuredInterface,
} from '../domain/types.js'
import { schemaFor } from '../schema/validate.js'
import { suggestedCommand } from '../session/review.js'
import type { ReadOps, WriteOps } from '../store/backend.js'
import { renderDoc } from '../view/render.js'
import { authorize } from './authz.js'
import { type CoreContext, mustBlock, progressEntry } from './tx.js'

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

/** A section that differs between two versions of a doc. */
export interface SectionChange {
  name: string
  /** In the older version, not in the newer one. */
  removed: boolean
  /** Interface sections: `+1 provides, -1 consumes`; empty otherwise. */
  delta: string
}

/** The sections that differ between two versions of a doc, in schema order then by name. */
export function changedSections(
  schema: DocSchema | undefined,
  old: Pick<Doc, 'sections'> | null,
  cur: Pick<Doc, 'sections'>,
): SectionChange[] {
  const known = schema?.sections.map((s) => s.name) ?? []
  const names = [...new Set([...Object.keys(old?.sections ?? {}), ...Object.keys(cur.sections)])]
  const ordered = [
    ...known.filter((n) => names.includes(n)),
    ...names.filter((n) => !known.includes(n)).sort(),
  ]
  const structured = new Set(
    schema?.sections.filter((s) => s.format === 'structured').map((s) => s.name),
  )
  return ordered
    .filter((n) => !same(old?.sections[n], cur.sections[n]))
    .map((n) => ({
      name: n,
      removed: !!old && n in old.sections && !(n in cur.sections),
      delta: structured.has(n) ? interfaceDelta(old?.sections[n], cur.sections[n]) : '',
    }))
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
  const changed = changedSections(schema, old, cur).map(
    (c) => `${c.name}${c.removed ? ' removed' : ''}${c.delta ? ` (${c.delta})` : ''}`,
  )
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

/**
 * A design or plan write, inside its transaction (`writeDoc`): file the new version for review
 * when its table row is not `off` and the writer's role does not approve reviews (the approvers'
 * own writes are not filed). One pending proposal per block and doc: a newer version replaces
 * the pending one's payload and note, keeping its id (the review list stays stable); after a
 * rejection the next version gets a new proposal. The note's "changed since" is computed against
 * the approved version, read from the committed history (`read`: the backend's read side).
 */
export async function fileReviewOnWrite(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  b: Block,
  type: ReviewType,
  cur: Doc,
): Promise<Proposal | null> {
  if (ctx.config.policies.review[type] === 'off') return null
  if (mayApprove(ctx.config.policies.review, by.role)) return null
  const version = cur.version
  const base = b.reviewed?.[type] ?? 0
  if (version <= base) return null
  const pending = (await t.listProposals({ status: 'pending' })).find(
    (p) => p.source === 'review' && p.blockId === b.id && p.kind === type,
  )
  const old = base ? await docAtVersion(ctx.backend.read, b.id, type, base) : null
  const what =
    base && !old
      ? `changes since v${base} unknown (no history)`
      : changedSince(schemaFor(ctx.config, b.kind, type), old, cur)
  const note = `${type} v${version} of '${b.title}': ${what}`
  const payload = { command: 'review.approve', args: { block: b.id, type, version } }
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
  /** Only what `by` may resolve (the agent tool); the CLI and the TUI read the whole queue. */
  resolvable = false,
): Promise<ReviewItem[]> {
  authorize(ctx.config, by.role, 'proposal.list')
  const read = ctx.backend.read
  const titles = new Map((await read.listBlocks()).map((b) => [b.id, b.title]))
  const policy = ctx.config.policies.review
  // A review the caller may not resolve is not theirs to read as a gate (the user: everything).
  const mine = (await read.listProposals(status === 'all' ? undefined : { status })).filter(
    (p) => !resolvable || p.source !== 'review' || mayApprove(policy, by.role),
  )
  return mine.map((p) => {
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
  /**
   * Design/plan reviews over an approved version: the sections that differ from it (names as in
   * the schema; `removed` ones are absent from `text`).
   */
  changed?: { since: number; sections: string[]; removed: string[] }
  /**
   * Design/plan reviews: the version before this one as text: the approved version if there is
   * one, else the version just before (absent for a first version or when the history lost it).
   */
  previous?: { version: number; text: string }
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
    const version = item.version ?? 0
    const doc = await docAtVersion(read, b.id, type, version)
    const text = doc
      ? renderDoc(ctx.config, b.kind, doc)
      : `${type} v${item.version} is no longer in the history (current: v${b.docVersions[type]})`
    const approved = b.reviewed?.[type] ?? 0
    const base = approved && approved < version ? approved : version - 1
    const old = base > 0 ? await docAtVersion(read, b.id, type, base) : null
    const out: ReviewShow = { item, doc, text }
    if (old) out.previous = { version: old.version, text: renderDoc(ctx.config, b.kind, old) }
    if (doc && old && base === approved) {
      const changes = changedSections(schemaFor(ctx.config, b.kind, type), old, doc)
      out.changed = {
        since: approved,
        sections: changes.filter((c) => !c.removed).map((c) => c.name),
        removed: changes.filter((c) => c.removed).map((c) => c.name),
      }
    }
    return out
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
