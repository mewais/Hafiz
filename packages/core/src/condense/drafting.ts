// Drafters in use (§7): turn a cheap-model draft (drafter.ts) into a proposal on the review
// queue. Opt-in; every function is a no-op unless drafters are enabled and a provider is set.

import { type NewProposal, proposalAdd } from '../commands/proposals.js'
import type { CoreContext } from '../commands/tx.js'
import type { BlockId, Proposal, SectionValue } from '../domain/types.js'
import { withRequestMeta } from '../llm/providers.js'
import type { LLMProvider } from '../llm/types.js'
import { Drafters } from './drafter.js'

export function draftersEnabled(ctx: CoreContext, provider: LLMProvider): boolean {
  return ctx.config.hafiz.llm.drafters.enabled && provider.name !== 'none'
}

/** Drafts are queued as the user's review items. */
const reviewer = (sessionId: string) => ({ sessionId, role: 'user' })

/**
 * A gist draft for a thread, queued as a proposal (`thread.park` with the gist) unless
 * `review.drafts` is off; the gist is returned either way (the park refusal carries it).
 */
export async function draftGist(
  ctx: CoreContext,
  provider: LLMProvider,
  sessionId: string,
  threadId: string,
): Promise<{ gist: string; proposal: Proposal | null } | null> {
  if (!draftersEnabled(ctx, provider)) return null
  const th = await ctx.backend.read.getThread(threadId)
  if (!th) return null
  const p = withRequestMeta(provider, { sessionId, purpose: 'gist' })
  const draft = await new Drafters(p).gist(th, ctx.config.logs.thread.gist_cap)
  if (!draft) return null
  const gist = draft.value
  const proposal = await proposalAdd(
    ctx,
    {
      kind: 'gist',
      source: 'drafter',
      blockId: th.blockId,
      payload: { command: 'thread.park', args: { id: th.id, gist } },
      note: `drafted gist for thread "${th.title}": ${gist}`,
    },
    reviewer(sessionId),
  )
  return { gist, proposal }
}

/** Digest sections are thin when the outcome is a few words or no pointers are given. */
export function digestIsThin(ctx: CoreContext, digest: Record<string, SectionValue>): boolean {
  const outcome = typeof digest.outcome === 'string' ? digest.outcome : ''
  const pointers = Array.isArray(digest.pointers) ? digest.pointers : []
  return ctx.tok.count(outcome) < 15 || pointers.length === 0
}

/** A fuller digest drafted from the block's progress log, queued as a proposal (drafts row). */
export async function draftDigest(
  ctx: CoreContext,
  provider: LLMProvider,
  sessionId: string,
  blockId: BlockId,
): Promise<Proposal | null> {
  if (!draftersEnabled(ctx, provider) || ctx.config.policies.review.drafts === 'off') return null
  const b = await ctx.backend.read.getBlock(blockId)
  if (!b) return null
  const log = (await ctx.backend.read.readLog(blockId, 'progress')).map((x) => x.entry)
  const p = withRequestMeta(provider, { sessionId, purpose: 'digest' })
  const draft = await new Drafters(p).digest(b, log)
  if (!draft) return null
  const d = draft.value
  const sections: Record<string, SectionValue> = { outcome: String(d.outcome) }
  sections.interface_delta = strList(d.interface_delta, ['none'])
  sections.pointers = (Array.isArray(d.pointers) ? d.pointers : [])
    .filter(
      (p): p is { label: string; ref: string } =>
        !!p && typeof p.label === 'string' && typeof p.ref === 'string',
    )
    .map((p) => ({ label: p.label, ref: p.ref }))
  const lessons = strList(d.lessons, [])
  if (lessons.length) sections.lessons = lessons
  const proposal: NewProposal = {
    kind: 'digest',
    source: 'drafter',
    blockId,
    payload: { command: 'doc.write', args: { block: blockId, type: 'digest', sections } },
    note: `drafted digest for "${b.title}" (the submitted one looked thin): ${String(d.outcome)}`,
  }
  return proposalAdd(ctx, proposal, reviewer(sessionId))
}

function strList(v: unknown, fallback: string[]): string[] {
  const l = Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : []
  return l.length ? l : fallback
}
