// Block and edge commands (§5.1): create, update, move, status transitions, request_done.

import { ValidationError } from '../domain/errors.js'
import { opaqueId, slugId } from '../domain/ids.js'
import type { TransitionContext } from '../domain/status.js'
import type {
  Actor,
  Block,
  BlockedOn,
  BlockId,
  Edge,
  Proposal,
  SectionValue,
  Status,
} from '../domain/types.js'
import { gitHead } from '../project/resolve.js'
import type { WriteOps } from '../store/backend.js'
import { authorize } from './authz.js'
import {
  type CommandResult,
  type CoreContext,
  checkVersion,
  mustBlock,
  onboardingDue,
  type Runner,
  recordDecision,
  runAs,
  runSystem,
  writeDoc,
} from './tx.js'

export interface NeedsConfirmation {
  needsConfirmation: true
  message: string
}

export interface BlockCreateArgs {
  parent: BlockId
  title: string
  kind?: string
  order?: number
  design?: Record<string, SectionValue>
  plan?: Record<string, SectionValue>
}

export async function blockCreate(
  ctx: CoreContext,
  by: Actor,
  args: BlockCreateArgs,
): Promise<CommandResult<Block>> {
  const spec = { command: 'block.create', major: true, target: args.title }
  return runAs(ctx, by, spec, async (t, notices) => {
    const parent = await mustBlock(t, args.parent)
    const kinds = ctx.config.kinds
    const kind = args.kind ?? kinds.default_kind
    const kindDef = kinds.kinds[kind]
    if (!kindDef)
      throw new ValidationError(
        `unknown kind '${kind}'. Known: ${Object.keys(kinds.kinds).join(', ')}`,
      )
    if (kinds.kinds[parent.kind]?.no_children)
      throw new ValidationError(`blocks of kind '${parent.kind}' cannot have children`)
    const siblings = (await t.listBlocks()).filter((b) => b.parentId === parent.id)
    const now = ctx.clock.now()
    const block: Block = {
      id: slugId(args.title),
      parentId: parent.id,
      title: args.title,
      kind,
      status: 'planned',
      order: args.order ?? siblings.length,
      version: 0,
      docVersions: { design: 0, plan: 0, digest: 0 },
      createdAt: now,
      updatedAt: now,
    }
    await t.putBlock(block, -1)
    await onboardingDue(t)
    if (args.design) await writeDoc(ctx, t, by, block, 'design', args.design, 0, notices)
    if (args.plan) await writeDoc(ctx, t, by, block, 'plan', args.plan, 0, notices)
    return block
  })
}

export interface BlockUpdateArgs {
  id: BlockId
  title?: string
  kind?: string
  order?: number
  expectedVersion?: number
}

export async function blockUpdate(
  ctx: CoreContext,
  by: Actor,
  args: BlockUpdateArgs,
): Promise<CommandResult<Block>> {
  const spec = { command: 'block.update', major: true, target: args.id }
  return runAs(ctx, by, spec, async (t) => {
    const b = await mustBlock(t, args.id)
    const v = checkVersion(b, args.expectedVersion)
    if (args.kind && !ctx.config.kinds.kinds[args.kind])
      throw new ValidationError(`unknown kind '${args.kind}'`)
    const nb: Block = {
      ...b,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.order !== undefined ? { order: args.order } : {}),
      version: v + 1,
      updatedAt: ctx.clock.now(),
    }
    await t.putBlock(nb, v)
    return nb
  })
}

export interface BlockMoveArgs {
  id: BlockId
  newParent: BlockId
  expectedVersion?: number
}

export async function blockMove(
  ctx: CoreContext,
  by: Actor,
  args: BlockMoveArgs,
): Promise<CommandResult<Block>> {
  const spec = { command: 'block.move', major: true, target: args.id }
  return runAs(ctx, by, spec, async (t) => {
    const b = await mustBlock(t, args.id)
    if (!b.parentId) throw new ValidationError('the root block cannot be moved')
    const v = checkVersion(b, args.expectedVersion)
    const all = await t.listBlocks()
    const byId = new Map(all.map((x) => [x.id, x]))
    // reject moving under own descendant
    for (
      let p: Block | undefined = byId.get(args.newParent);
      p;
      p = p.parentId ? byId.get(p.parentId) : undefined
    )
      if (p.id === b.id) throw new ValidationError('cannot move a block under its own descendant')
    await mustBlock(t, args.newParent)
    const nb: Block = {
      ...b,
      parentId: args.newParent,
      version: v + 1,
      updatedAt: ctx.clock.now(),
    }
    await t.putBlock(nb, v)
    return nb
  })
}

export interface BlockSetStatusArgs {
  id: BlockId
  status: Status
  digest?: Record<string, SectionValue>
  reason?: string
  blockedOn?: BlockedOn
  confirmed?: boolean
  expectedVersion?: number
}

/** A status transition through the status machine's guards; `run` decides the authz path. */
export async function blockSetStatus(
  ctx: CoreContext,
  by: Actor,
  args: BlockSetStatusArgs,
  run: Runner = runAs,
): Promise<CommandResult<Block | NeedsConfirmation>> {
  const spec = { command: 'block.set_status', qualifier: args.status, major: true, target: args.id }
  return run(ctx, by, spec, async (t, notices) => {
    const b = await mustBlock(t, args.id)
    checkVersion(b, args.expectedVersion)
    const all = await t.listBlocks()
    const doneReview = ctx.config.policies.review.done
    const tc: TransitionContext = {
      block: b,
      to: args.status,
      children: all.filter((x) => x.parentId === b.id),
      threads: await t.listThreads(b.id),
      digest: await t.getDoc(b.id, 'digest'),
      args: {
        digestProvided: !!args.digest,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(args.blockedOn ? { blockedOn: args.blockedOn } : {}),
        ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
      },
      doneReview,
    }
    const outcome = ctx.status.check(tc)
    if (!outcome.proceed)
      return {
        needsConfirmation: true,
        message: `Marking '${b.title}' (${b.id}) done requires confirmation. Ask the user, then call again with confirmed: true.`,
      } satisfies NeedsConfirmation
    if (args.digest) await writeDoc(ctx, t, by, b, 'digest', args.digest, undefined, notices)
    const now = ctx.clock.now()
    const reopen = b.status === 'done' && args.status === 'active'
    const nb: Block = { ...b, status: args.status, version: b.version + 1, updatedAt: now }
    delete nb.blockedOn
    if (args.status === 'blocked' && args.blockedOn) nb.blockedOn = args.blockedOn
    if (args.status === 'done') {
      // HEAD of the caller's own working tree (a worktree, when it runs in one); the
      // daemon's startup checkout only when the session did not say where it runs.
      const dir = (await t.getSession(by.sessionId))?.worktree ?? ctx.repoDir
      const commit = dir ? gitHead(dir) : undefined
      nb.doneAt = commit ? { ts: now, commit } : { ts: now }
    }
    if (reopen) {
      nb.digestStale = true
      delete nb.doneAt
    }
    await t.putBlock(nb, b.version)
    if (args.reason)
      await recordDecision(ctx, t, by, b.id, {
        title: `${reopen ? 'Reopened' : args.status === 'dropped' ? 'Dropped' : `Status → ${args.status}`}: ${b.title}`,
        decision: args.reason,
      })
    if (args.status === 'active') await activateAncestors(ctx, t, nb, now)
    // `review.done: queue`: done applies and the user reviews it later (gate asked above).
    if (args.status === 'done' && doneReview === 'queue') {
      await t.putProposal({
        id: opaqueId('prop'),
        kind: 'status',
        source: 'auto_done',
        blockId: b.id,
        payload: { command: 'block.set_status', args: { id: b.id, status: 'done' } },
        note: `'${b.title}' was marked done by ${by.role}; review the digest.`,
        status: 'pending',
        createdAt: now,
      })
    }
    return nb
  })
}

/**
 * `status.activate_parent_on_child_active`: a block turning active activates its planned
 * ancestors, nearest first, so no active block sits under a planned one.
 */
export async function activateAncestors(
  ctx: CoreContext,
  t: WriteOps,
  b: Block,
  now: string,
): Promise<void> {
  if (!ctx.config.policies.status.activate_parent_on_child_active) return
  for (let id = b.parentId; id; ) {
    const p = await t.getBlock(id)
    if (p?.status !== 'planned') return
    await t.putBlock({ ...p, status: 'active', version: p.version + 1, updatedAt: now }, p.version)
    id = p.parentId
  }
}

/**
 * `status.activate_on_spawn`: a session of one of these roles opened on a planned block starts
 * its work: the block (and its planned ancestors) turn active in the session-open write.
 * Returns true when it changed a block (the caller bumps the epoch).
 */
export async function activateOnSpawn(
  ctx: CoreContext,
  t: WriteOps,
  role: string,
  blockId: BlockId,
): Promise<boolean> {
  if (!ctx.config.policies.status.activate_on_spawn.includes(role)) return false
  const b = await t.getBlock(blockId)
  if (b?.status !== 'planned' || !ctx.status.canTransition('planned', 'active')) return false
  const now = ctx.clock.now()
  const nb: Block = { ...b, status: 'active', version: b.version + 1, updatedAt: now }
  await t.putBlock(nb, b.version)
  await activateAncestors(ctx, t, nb, now)
  return true
}

export interface BlockRequestDoneArgs {
  id: BlockId
  digest: Record<string, SectionValue>
}

/**
 * Worker path: write the digest, then apply `done` (`review.done` off or queue) or, under
 * `gate`, enqueue it for the manager.
 */
export async function blockRequestDone(
  ctx: CoreContext,
  by: Actor,
  args: BlockRequestDoneArgs,
): Promise<CommandResult<Block | NeedsConfirmation | { queued: true; proposal: Proposal }>> {
  // Gated as request_done; unless `review.done` gates, it applies `done` without the caller
  // needing `block.set_status:done` itself.
  authorize(ctx.config, by.role, 'block.request_done')
  if (ctx.config.policies.review.done !== 'gate')
    return blockSetStatus(ctx, by, { id: args.id, status: 'done', digest: args.digest }, runSystem)
  const spec = { command: 'block.request_done', major: false, target: args.id }
  return runAs(ctx, by, spec, async (t, notices) => {
    const b = await mustBlock(t, args.id)
    // Everything but the review itself is checked now, so the worker hears what is wrong (an
    // open thread, a planned block) instead of the manager when it accepts the request.
    ctx.status.check({
      block: b,
      to: 'done',
      children: (await t.listBlocks()).filter((x) => x.parentId === b.id),
      threads: await t.listThreads(b.id),
      digest: null,
      args: { digestProvided: true, confirmed: true },
      doneReview: 'gate',
    })
    await writeDoc(ctx, t, by, b, 'digest', args.digest, undefined, notices)
    const proposal: Proposal = {
      id: opaqueId('prop'),
      kind: 'status',
      source: 'auto_done',
      blockId: b.id,
      payload: {
        command: 'block.set_status',
        args: { id: b.id, status: 'done', confirmed: true },
      },
      note: `${by.role} requests '${b.title}' be marked done; digest written.`,
      status: 'pending',
      createdAt: ctx.clock.now(),
    }
    await t.putProposal(proposal)
    return { queued: true as const, proposal }
  })
}

export interface EdgeArgs {
  from: BlockId
  to: BlockId
  kind?: string
}

export async function edgeAdd(
  ctx: CoreContext,
  by: Actor,
  args: EdgeArgs,
): Promise<CommandResult<Edge>> {
  const spec = { command: 'edge.add', major: true, target: `${args.from}→${args.to}` }
  return runAs(ctx, by, spec, async (t) => {
    if (args.from === args.to) throw new ValidationError('a block cannot depend on itself')
    await mustBlock(t, args.from)
    await mustBlock(t, args.to)
    const e: Edge = { from: args.from, to: args.to, kind: args.kind ?? 'depends_on' }
    await t.putEdge(e)
    return e
  })
}

export async function edgeRemove(
  ctx: CoreContext,
  by: Actor,
  args: EdgeArgs,
): Promise<CommandResult<void>> {
  const spec = { command: 'edge.remove', major: true, target: `${args.from}→${args.to}` }
  return runAs(ctx, by, spec, async (t) => {
    await t.deleteEdge({ from: args.from, to: args.to, kind: args.kind ?? 'depends_on' })
  })
}
