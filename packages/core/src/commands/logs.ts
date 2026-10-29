// Log commands (§5.1): progress (which may mark a plan step), decisions and threads.
// Append-only, no CAS.

import { NotFoundError, ValidationError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import type {
  Actor,
  BlockId,
  Decision,
  ProgressEntry,
  ProgressKind,
  Standing,
  Step,
  StepEvent,
  StepStatus,
  Thread,
} from '../domain/types.js'
import type { WriteOps } from '../store/backend.js'
import {
  type CommandResult,
  type CoreContext,
  isMinor,
  mustBlock,
  progressEntry,
  type Runner,
  recordDecision,
  runAs,
  runSystem,
} from './tx.js'

/** A plan step's new status, carried by a progress entry (`progress.append` `step`). */
export interface StepMark {
  id: string
  status: StepStatus
}

/** Append a step event inside the caller's transaction; the step must be in the block's plan. */
async function appendStep(
  ctx: CoreContext,
  t: WriteOps,
  by: Actor,
  blockId: BlockId,
  step: StepMark,
): Promise<StepEvent> {
  const statuses = ctx.config.logs.step.statuses
  if (!statuses.includes(step.status))
    throw new ValidationError(`step status must be one of ${statuses.join(', ')}`)
  const plan = await t.getDoc(blockId, 'plan')
  const steps = (plan?.sections.steps ?? []) as Step[]
  if (!steps.some((s) => s.id === step.id))
    throw new NotFoundError(
      'step',
      `${step.id} (known: ${steps.map((s) => s.id).join(', ') || 'none — write a plan first'})`,
    )
  const ev: StepEvent = { blockId, stepId: step.id, status: step.status, ts: ctx.clock.now(), by }
  await t.appendLog(blockId, 'steps', ev)
  return ev
}

export interface ProgressAppendArgs {
  block: BlockId
  kind: ProgressKind
  text: string
  refs?: string[]
  /** Also mark a plan step, in the same transaction (one audit entry). */
  step?: StepMark
}

export async function progressAppend(
  ctx: CoreContext,
  by: Actor,
  args: ProgressAppendArgs,
): Promise<CommandResult<ProgressEntry>> {
  return logProgress(ctx, by, 'progress.append', args.kind, args, runAs)
}

export interface SystemProgressArgs {
  block: BlockId
  kind: 'report' | 'changed'
  text: string
}

/**
 * System progress: Hafiz's own notes on a block, written for a session without a role check.
 * `report` is a host plugin storing a finished subagent's final message; `changed` records
 * something Hafiz did on the session's behalf (e.g. started tracking). Never a decision. The
 * entry is attributed to the acting session and audited as `system.progress`. Not a registered
 * command, so `dispatch` (and every tool catalogue) cannot reach it.
 */
export async function systemProgress(
  ctx: CoreContext,
  by: Actor,
  args: SystemProgressArgs,
): Promise<CommandResult<ProgressEntry>> {
  return logProgress(ctx, by, 'system.progress', undefined, args, runSystem)
}

function logProgress(
  ctx: CoreContext,
  by: Actor,
  command: string,
  qualifier: string | undefined,
  args: ProgressAppendArgs,
  run: Runner,
): Promise<CommandResult<ProgressEntry>> {
  const major = !isMinor(ctx, 'progress') || (!!args.step && !isMinor(ctx, 'steps'))
  const spec = { command, qualifier, major, target: args.block }
  return run(ctx, by, spec, async (t) => {
    const b = await mustBlock(t, args.block)
    const cfg = ctx.config.logs.progress
    if (!cfg.kinds.includes(args.kind))
      throw new ValidationError(`progress kind must be one of ${cfg.kinds.join(', ')}`)
    const n = ctx.tok.count(args.text)
    const cap = args.kind === 'report' ? ctx.config.compliance.report_capture.cap_tokens : cfg.cap
    if (n > cap * (1 + ctx.config.hafiz.tokenizer.soft_zone))
      throw new ValidationError(
        `progress entry is ${n} tokens; cap is ${cap}. One finding per entry.`,
        { measured: n, cap },
      )
    if (args.step) await appendStep(ctx, t, by, b.id, args.step)
    const e = progressEntry(ctx, by, b.id, args.kind, args)
    await t.appendLog(b.id, 'progress', e)
    return e
  })
}

export interface DecisionRecordArgs {
  block: BlockId
  title: string
  decision: string
  rationale?: string
  standing?: Standing
  supersedes?: string
}

export async function decisionRecord(
  ctx: CoreContext,
  by: Actor,
  args: DecisionRecordArgs,
): Promise<CommandResult<Decision>> {
  const spec = { command: 'decision.record', major: true, target: args.block }
  return runAs(ctx, by, spec, async (t) => {
    await mustBlock(t, args.block)
    return recordDecision(ctx, t, by, args.block, args)
  })
}

// ───────────────────────────── threads ─────────────────────────────

export interface ThreadOpenArgs {
  block: BlockId
  title: string
  text?: string
}

export async function threadOpen(
  ctx: CoreContext,
  by: Actor,
  args: ThreadOpenArgs,
): Promise<CommandResult<Thread>> {
  const spec = { command: 'thread.open', major: false, target: args.block }
  return runAs(ctx, by, spec, async (t) => {
    const b = await mustBlock(t, args.block)
    const now = ctx.clock.now()
    const th: Thread = {
      id: opaqueId('thr'),
      blockId: b.id,
      title: args.title,
      status: 'open',
      entries: args.text ? [{ ts: now, by, text: args.text }] : [],
      createdAt: now,
      updatedAt: now,
      by,
    }
    await t.putThread(th)
    return th
  })
}

function threadTransition(
  ctx: CoreContext,
  by: Actor,
  command: string,
  id: string,
  to: Thread['status'],
  fn?: (th: Thread) => void,
): Promise<CommandResult<Thread>> {
  return runAs(ctx, by, { command, major: false, target: id }, async (t) => {
    const th = await t.getThread(id)
    if (!th) throw new NotFoundError('thread', id)
    fn?.(th)
    th.status = to
    th.updatedAt = ctx.clock.now()
    await t.putThread(th)
    return th
  })
}

export interface ThreadParkArgs {
  id: string
  gist: string
}

export async function threadPark(
  ctx: CoreContext,
  by: Actor,
  args: ThreadParkArgs,
): Promise<CommandResult<Thread>> {
  const cap = ctx.config.logs.thread.gist_cap
  return threadTransition(ctx, by, 'thread.park', args.id, 'parked', (th) => {
    if (!args.gist?.trim())
      throw new ValidationError(
        'a gist is required to park a thread: what was being discussed and where it stands.',
      )
    const n = ctx.tok.count(args.gist)
    if (n > cap * (1 + ctx.config.hafiz.tokenizer.soft_zone))
      throw new ValidationError(`gist is ${n} tokens; cap is ${cap}.`, { measured: n, cap })
    th.gist = args.gist
  })
}

export async function threadResume(
  ctx: CoreContext,
  by: Actor,
  args: { id: string },
): Promise<CommandResult<Thread>> {
  return threadTransition(ctx, by, 'thread.resume', args.id, 'open')
}

export interface ThreadResolveArgs {
  id: string
  outcome?: string
}

export async function threadResolve(
  ctx: CoreContext,
  by: Actor,
  args: ThreadResolveArgs,
): Promise<CommandResult<Thread>> {
  return threadTransition(ctx, by, 'thread.resolve', args.id, 'resolved', (th) => {
    if (args.outcome) th.entries.push({ ts: ctx.clock.now(), by, text: args.outcome })
  })
}

export interface ThreadAppendArgs {
  id: string
  text: string
}

export async function threadAppend(
  ctx: CoreContext,
  by: Actor,
  args: ThreadAppendArgs,
): Promise<CommandResult<Thread>> {
  const cap = ctx.config.logs.thread.entry_cap
  const spec = { command: 'thread.append', major: false, target: args.id }
  return runAs(ctx, by, spec, async (t) => {
    const th = await t.getThread(args.id)
    if (!th) throw new NotFoundError('thread', args.id)
    const n = ctx.tok.count(args.text)
    if (n > cap * (1 + ctx.config.hafiz.tokenizer.soft_zone))
      throw new ValidationError(`entry exceeds ${cap} tokens`, { measured: n, cap })
    th.entries.push({ ts: ctx.clock.now(), by, text: args.text })
    th.updatedAt = ctx.clock.now()
    await t.putThread(th)
    return th
  })
}
