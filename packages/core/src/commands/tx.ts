// The one write path every Core module shares (§5.3): authz → dirty check → transaction → epoch
// bump (major) → audit. Two entry points make the authorization visible at the call site:
// `runAs` is role-gated against the actor's allowlist; `runSystem` is Hafiz's own bookkeeping
// (sessions, counters, condensation, proposals, project setup) and is never reachable through
// `dispatch` or the tool catalogue.

import type { Config, DocSchema } from '../config/schema.js'
import type { Clock } from '../domain/clock.js'
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import type { StatusMachine } from '../domain/status.js'
import type {
  Actor,
  Block,
  BlockId,
  Decision,
  Doc,
  DocType,
  ProgressEntry,
  ProgressKind,
  SectionValue,
  Standing,
  StructuredInterface,
} from '../domain/types.js'
import { type Notice, schemaFor, validateDoc } from '../schema/validate.js'
import type { StorageBackend, WriteOps } from '../store/backend.js'
import { countValue, type Tokenizer } from '../tokenizer.js'
import { authorize } from './authz.js'
import { fileReviewOnWrite } from './review.js'

/** What every Core module works over. */
export interface CoreContext {
  readonly config: Config
  readonly backend: StorageBackend
  readonly tok: Tokenizer
  readonly clock: Clock
  readonly status: StatusMachine
  /** The project's repo; `done` records its HEAD so `hafiz doctor` can detect drift. */
  readonly repoDir: string | undefined
}

export interface CommandResult<T = unknown> {
  result: T
  notices: Notice[]
  commit?: string
}

/** One write: the command it audits as, whether it bumps the epoch, and what it touches. */
export interface TxSpec {
  command: string
  /** Allowlist qualifier (`doc.write:design`); also part of the audited command. */
  qualifier?: string | undefined
  major: boolean
  target: string
  /** Commit message override. */
  message?: string
}

export type TxBody<T> = (t: WriteOps, notices: Notice[]) => Promise<T>

/** A role-gated write: the actor's role must allow `spec.command[:qualifier]`. */
export async function runAs<T>(
  ctx: CoreContext,
  by: Actor,
  spec: TxSpec,
  fn: TxBody<T>,
): Promise<CommandResult<T>> {
  authorize(ctx.config, by.role, spec.command, spec.qualifier)
  return transact(ctx, by, spec, fn)
}

/** An internal write, not role-gated. Never wire one of these to `dispatch`. */
export async function runSystem<T>(
  ctx: CoreContext,
  by: Actor,
  spec: TxSpec,
  fn: TxBody<T>,
): Promise<CommandResult<T>> {
  return transact(ctx, by, spec, fn)
}

/** A write runner, for code shared by a role-gated and a system path. */
export type Runner = typeof runAs

async function transact<T>(
  ctx: CoreContext,
  by: Actor,
  spec: TxSpec,
  fn: TxBody<T>,
): Promise<CommandResult<T>> {
  const { command, qualifier, major, target } = spec
  const notices: Notice[] = []
  const dirty = await ctx.backend.dirty()
  if (dirty.length)
    notices.push({
      level: 'warn',
      text: `store files were edited outside Hafiz: ${dirty.join(', ')}; they will be committed with this write`,
    })
  const meta = { by, command, major, ...(spec.message ? { message: spec.message } : {}) }
  const { result, commit } = await ctx.backend.tx(meta, async (t) => {
    const r = await fn(t, notices)
    if (major) {
      const p = await t.getProject()
      if (p) await t.putProject({ ...p, epoch: p.epoch + 1 })
    }
    await t.appendAudit({
      ts: ctx.clock.now(),
      by,
      command: qualifier ? `${command}:${qualifier}` : command,
      target,
    })
    return r
  })
  return commit ? { result, notices, commit } : { result, notices }
}

// ───────────────────────────── shared write helpers ─────────────────────────────

export function isMinor(ctx: CoreContext, path: string): boolean {
  return ctx.config.policies.epoch.minor_paths.includes(path)
}

export function bump(
  c: Record<string, number>,
  delta: Record<string, number>,
): Record<string, number> {
  const out = { ...c }
  for (const [k, v] of Object.entries(delta)) out[k] = (out[k] ?? 0) + v
  return out
}

export async function mustBlock(
  t: { getBlock(id: BlockId): Promise<Block | null> },
  id: BlockId,
): Promise<Block> {
  const b = await t.getBlock(id)
  if (!b) throw new NotFoundError('block', id)
  return b
}

export function checkVersion(b: Block, expected: number | undefined): number {
  if (expected !== undefined && expected !== b.version)
    throw new ConflictError(`block ${b.id}`, expected, b.version, b)
  return b.version
}

export async function writeDoc(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  block: Block,
  type: DocType,
  sections: Record<string, SectionValue>,
  expectedVersion: number | undefined,
  notices: Notice[],
): Promise<Doc> {
  const schema = schemaFor(ctx.config, block.kind, type)
  const v = validateDoc(ctx.config, ctx.tok, schema, sections)
  notices.push(...v.notices)
  const cur = block.docVersions[type]
  if (expectedVersion !== undefined && expectedVersion !== cur) {
    const current = await t.getDoc(block.id, type)
    throw new ConflictError(`${type} of ${block.id}`, expectedVersion, cur, current)
  }
  const doc: Doc = {
    blockId: block.id,
    type,
    version: cur + 1,
    sections: v.sections,
    updatedAt: ctx.clock.now(),
    by,
  }
  await t.putDoc(doc, cur)
  const updated: Block = {
    ...block,
    docVersions: { ...block.docVersions, [type]: doc.version },
    updatedAt: doc.updatedAt,
    version: block.version + 1,
  }
  if (type === 'digest') delete updated.digestStale
  await t.putBlock(updated, block.version)
  Object.assign(block, updated)
  if (type === 'digest') delete block.digestStale // Object.assign cannot remove keys
  if (type === 'design') await deriveDependencies(t, block, schema, v.sections, notices)
  // Every design/plan version goes up for review as it is written (policies.yaml review).
  if (type === 'design' || type === 'plan') await fileReviewOnWrite(ctx, t, by, block, type, doc)
  if (block.parentId === null) {
    if (type === 'design') await finishOnboarding(ctx, t, by, block)
    else await onboardingDue(t)
  }
  return doc
}

/**
 * A design's interface is the source of a block's dependencies: after every design write the
 * block's `depends_on` edges are exactly the blocks its `consumes[].block` entries name (by id,
 * or by a title that matches one block). Names that match no block get a notice, not an error.
 * Kinds whose design has no interface section keep their edges as they are (CLI `edge.*`).
 */
async function deriveDependencies(
  t: WriteOps,
  block: Block,
  schema: DocSchema,
  sections: Record<string, SectionValue>,
  notices: Notice[],
): Promise<void> {
  const ifaces = schema.sections.filter((s) => s.format === 'structured')
  if (!ifaces.length) return
  const names = ifaces.flatMap((s) =>
    ((sections[s.name] as StructuredInterface | undefined)?.consumes ?? [])
      .map((c) => (typeof c.block === 'string' ? c.block.trim() : ''))
      .filter(Boolean),
  )
  const blocks = await t.listBlocks()
  const resolve = (name: string) => {
    const byId = blocks.find((b) => b.id === name)
    if (byId) return byId.id
    const byTitle = blocks.filter((b) => b.title.toLowerCase() === name.toLowerCase())
    return byTitle.length === 1 ? byTitle[0]?.id : undefined
  }
  const want = new Set<BlockId>()
  const unknown: string[] = []
  for (const n of new Set(names)) {
    const to = resolve(n)
    if (!to) unknown.push(n)
    else if (to !== block.id) want.add(to)
  }
  const kind = 'depends_on'
  const have = (await t.listEdges()).filter((e) => e.from === block.id && e.kind === kind)
  for (const e of have) if (!want.has(e.to)) await t.deleteEdge(e)
  for (const to of want)
    if (!have.some((e) => e.to === to)) await t.putEdge({ from: block.id, to, kind })
  if (unknown.length)
    notices.push({
      level: 'warn',
      text: `interface.consumes names no known block: ${unknown.join(', ')}; no dependency recorded for ${unknown.length > 1 ? 'them' : 'it'}. Use block ids from your context.`,
    })
}

/** Tracked work has started: a pending onboarding becomes due (the manager's view asks for it). */
export async function onboardingDue(t: Pick<WriteOps, 'getProject' | 'putProject'>): Promise<void> {
  const project = await t.getProject()
  if (project?.onboarding === 'pending') await t.putProject({ ...project, onboarding: 'due' })
}

/** The first root design of a brownfield project completes its onboarding. */
async function finishOnboarding(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  root: Block,
): Promise<void> {
  const project = await t.getProject()
  if (!project?.onboarding) return
  const { onboarding: _done, ...rest } = project
  await t.putProject(rest)
  // Hafiz is not a decision-maker: onboarding is a progress entry, never a decision.
  await t.appendLog(
    root.id,
    'progress',
    progressEntry(ctx, by, root.id, 'changed', {
      text: 'Onboarded existing codebase: the root design describes it as it was when Hafiz started tracking it.',
    }),
  )
}

export function progressEntry(
  ctx: CoreContext,
  by: Actor,
  blockId: BlockId,
  kind: ProgressKind,
  args: { text: string; refs?: string[] },
): ProgressEntry {
  return {
    id: opaqueId('prg'),
    blockId,
    ts: ctx.clock.now(),
    by,
    kind,
    text: args.text,
    refs: args.refs ?? [],
  }
}

export async function recordDecision(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  blockId: BlockId,
  d: {
    title: string
    decision: string
    rationale?: string
    standing?: Standing
    supersedes?: string
  },
): Promise<Decision> {
  const caps = ctx.config.logs.decision
  if (d.standing && !caps.standing.includes(d.standing))
    throw new ValidationError(`standing must be one of ${caps.standing.join(', ')}`)
  const soft = 1 + ctx.config.hafiz.tokenizer.soft_zone
  const n = countValue(ctx.tok, `${d.title} ${d.decision} ${d.rationale ?? ''}`)
  const cap = d.standing ? caps.standing_cap : caps.cap
  if (n > cap * soft)
    throw new ValidationError(
      `decision is ${n} tokens; cap is ${cap}. State the decision, not the discussion.`,
      { measured: n, cap },
    )
  if (d.supersedes) {
    const all = await t.readLog(blockId, 'decisions')
    if (!all.some((r) => r.entry.id === d.supersedes))
      throw new NotFoundError('decision', d.supersedes)
  }
  const entry: Decision = {
    id: opaqueId('dec'),
    blockId,
    ts: ctx.clock.now(),
    by,
    title: d.title,
    decision: d.decision,
    ...(d.rationale ? { rationale: d.rationale } : {}),
    ...(d.standing ? { standing: d.standing } : {}),
    ...(d.supersedes ? { supersedes: d.supersedes } : {}),
  }
  await t.appendLog(blockId, 'decisions', entry)
  return entry
}
