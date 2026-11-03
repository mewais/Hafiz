// The review queue (§7): proposals are added by Hafiz (compliance, condenser, drafters, done
// under `review.done: queue`, design/plan reviews) and resolved by a role allowed to accept or
// reject them (design/plan reviews: `policies.yaml review.approver`).

import { NotFoundError, ValidationError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import { reviewModeOf } from '../domain/review.js'
import type { Actor, Proposal } from '../domain/types.js'
import { authorizeResolve } from './authz.js'
import { pinReview } from './review.js'
import { type CommandResult, type CoreContext, runAs, runSystem } from './tx.js'

export type NewProposal = Omit<Proposal, 'id' | 'status' | 'createdAt'>

/** Runs a proposal's command as the accepting actor (the raw handler, no dispatch hooks). */
export type PerformCommand = (
  by: Actor,
  command: string,
  args: Record<string, unknown>,
) => Promise<CommandResult<unknown>>

export interface ProposalResolveArgs {
  id: string
  accept: boolean
  /** Why it is rejected (or a remark on acceptance): stored on the proposal; reviewers hear it. */
  note?: string
}

export async function proposalResolve(
  ctx: CoreContext,
  by: Actor,
  args: ProposalResolveArgs,
  perform: PerformCommand,
): Promise<CommandResult<Proposal>> {
  const command = args.accept ? 'proposal.accept' : 'proposal.reject'
  const p = (await ctx.backend.read.listProposals()).find((x) => x.id === args.id)
  authorizeResolve(ctx.config, by.role, command, p ?? { source: 'compliance' })
  if (!p) throw new NotFoundError('proposal', args.id)
  if (p.status !== 'pending') throw new ValidationError(`proposal already ${p.status}`)
  const review = p.source === 'review'
  // Accepting a not-yet-applied proposal performs its command as the accepting actor.
  // (An 'auto_done' review item is already applied; a queued request_done carries confirmed: true.
  // A design/plan review pins the version instead.)
  const applied = review || (p.source === 'auto_done' && p.payload.args.confirmed !== true)
  if (args.accept && !applied) await perform(by, p.payload.command, p.payload.args)
  const note = args.note?.trim()
  // Approving a review changes the block (its pinned version), so it is a major write.
  const spec = { command, major: review && args.accept, target: p.id }
  const out = await runAs(ctx, by, spec, async (t) => {
    if (review && args.accept) await pinReview(ctx, t, by, p)
    const np: Proposal = {
      ...p,
      status: args.accept ? 'accepted' : 'rejected',
      resolvedAt: ctx.clock.now(),
      resolvedBy: by,
      ...(note ? { resolutionNote: note } : {}),
    }
    await t.putProposal(np)
    return np
  })
  return out
}

/**
 * Queue a proposal for review: Hafiz's own write, attributed to `by`. Null when its table row
 * (`policies.yaml review`) is `off`.
 */
export async function proposalAdd(
  ctx: CoreContext,
  p: NewProposal,
  by: Actor,
): Promise<Proposal | null> {
  if (reviewModeOf(ctx.config.policies.review, p) === 'off') return null
  const spec = { command: 'proposal.add', major: false, target: p.blockId ?? 'project' }
  const { result } = await runSystem(ctx, by, spec, async (t) => {
    const np: Proposal = {
      ...p,
      id: opaqueId('prop'),
      status: 'pending',
      createdAt: ctx.clock.now(),
    }
    await t.putProposal(np)
    return np
  })
  return result
}
