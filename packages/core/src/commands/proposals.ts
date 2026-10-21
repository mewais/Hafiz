// The review queue (§7): proposals are added by Hafiz (compliance, condenser, drafters, auto
// done) and resolved by a role allowed to accept or reject them.

import { NotFoundError, ValidationError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import type { Actor, Proposal } from '../domain/types.js'
import { authorize } from './authz.js'
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
}

export async function proposalResolve(
  ctx: CoreContext,
  by: Actor,
  args: ProposalResolveArgs,
  perform: PerformCommand,
): Promise<CommandResult<Proposal>> {
  const command = args.accept ? 'proposal.accept' : 'proposal.reject'
  authorize(ctx.config, by.role, command)
  const p = (await ctx.backend.read.listProposals()).find((x) => x.id === args.id)
  if (!p) throw new NotFoundError('proposal', args.id)
  if (p.status !== 'pending') throw new ValidationError(`proposal already ${p.status}`)
  // Accepting a not-yet-applied proposal performs its command as the accepting actor.
  // (An 'auto_done' review item is already applied; a queued request_done carries confirmed: true.)
  const applied = p.source === 'auto_done' && p.payload.args.confirmed !== true
  if (args.accept && !applied) await perform(by, p.payload.command, p.payload.args)
  return runAs(ctx, by, { command, major: false, target: p.id }, async (t) => {
    const np: Proposal = {
      ...p,
      status: args.accept ? 'accepted' : 'rejected',
      resolvedAt: ctx.clock.now(),
      resolvedBy: by,
    }
    await t.putProposal(np)
    return np
  })
}

/** Queue a proposal for review: Hafiz's own write, attributed to `by`. */
export async function proposalAdd(ctx: CoreContext, p: NewProposal, by: Actor): Promise<Proposal> {
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
