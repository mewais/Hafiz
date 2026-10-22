// Condensation (§6.5): fold the turns leaving a session's tail into its unfiled summary, and the
// `hafiz checkpoint` request that asks for it. Both are system writes on the session.

import type { NewProposal } from '../commands/proposals.js'
import { bump, type CoreContext, runSystem } from '../commands/tx.js'
import { NotFoundError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import type { Actor, BlockId, CondenseCursor, Session } from '../domain/types.js'
import { providerEnabled, withRequestMeta } from '../llm/providers.js'
import type { LLMProvider, LLMUsage } from '../llm/types.js'
import type { Notice } from '../schema/validate.js'
import { COST } from '../session/cost.js'
import { envelopeFor } from '../view/service.js'
import { type CondenseInput, Condenser, type CondenseTurn } from './condenser.js'

/** True when a condenser provider is configured (otherwise the host keeps its own compaction). */
export function condenserEnabled(provider: LLMProvider): boolean {
  return providerEnabled({ provider: provider.name })
}

/** `hafiz checkpoint`: have the next shaping condense whatever it can. */
export async function checkpointRequest(
  ctx: CoreContext,
  sessionId: string,
  on = true,
): Promise<boolean> {
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s || s.endedAt) return false
  if (!!s.checkpointRequested === on) return true
  const spec = { command: 'session.checkpoint', major: false, target: sessionId }
  await runSystem(ctx, { sessionId, role: s.role }, spec, async (t) => {
    const cur = (await t.getSession(sessionId)) ?? s
    const ns: Session = { ...cur, updatedAt: ctx.clock.now() }
    if (on) ns.checkpointRequested = true
    else delete ns.checkpointRequested
    await t.putSession(ns)
  })
  return true
}

export interface CondenseArgs {
  turns: CondenseTurn[]
  through: CondenseCursor
}

export interface CondenseOutcome {
  status: 'condensed' | 'skipped' | 'failed'
  summaryTokens?: number
  proposals: number
  notices: Notice[]
}

/**
 * Fold `turns` (the slice leaving the tail, ending at `through`) into the session's unfiled
 * summary. All-or-nothing: on any failure the previous summary and cursor stay, a warn notice
 * is returned, and the tail keeps its turns. Proposals go to the review queue, nothing else
 * is written to the store.
 */
export async function sessionCondense(
  ctx: CoreContext,
  condenser: LLMProvider,
  sessionId: string,
  args: CondenseArgs,
): Promise<CondenseOutcome> {
  const skip = (why: string) => ({
    status: 'skipped' as const,
    proposals: 0,
    notices: [{ level: 'info' as const, text: why }],
  })
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s) throw new NotFoundError('session', sessionId)
  if (!condenserEnabled(condenser)) return skip('no condenser provider is configured')
  if (s.condensed?.fingerprint === args.through.fingerprint)
    return skip('already condensed up to that turn')
  if (!args.turns.length) return skip('nothing to condense')
  const actor: Actor = { sessionId, role: s.role }
  const tok = ctx.tok
  const cap = ctx.config.tail.unfiled.cap_tokens
  const input: CondenseInput = {
    previous: s.unfiledSummary ?? '',
    turns: args.turns,
    envelope: await envelopeFor(ctx, s),
    focus: s.focus.blocks,
    capTokens: cap,
  }
  let out: Awaited<ReturnType<Condenser['run']>>
  try {
    const provider = withRequestMeta(condenser, { sessionId, purpose: 'condense' })
    out = await new Condenser(provider, tok).run(input)
  } catch (e) {
    const text = `condensation failed, keeping the previous summary: ${e instanceof Error ? e.message : String(e)}`
    const spec = { command: 'session.condense_failed', major: false, target: sessionId }
    await runSystem(ctx, actor, spec, async (t) => {
      const cur = (await t.getSession(sessionId)) ?? s
      const ns: Session = {
        ...cur,
        counters: bump(cur.counters, { [COST.condenseFailures]: 1 }),
      }
      delete ns.checkpointRequested
      await t.putSession(ns)
    })
    return { status: 'failed', proposals: 0, notices: [{ level: 'warn', text }] }
  }
  const usage: LLMUsage = out.usage ?? {
    inputTokens:
      tok.count(input.previous) +
      tok.count(input.envelope) +
      args.turns.reduce((n, t) => n + tok.count(t.content), 0),
    outputTokens: tok.count(out.summary),
  }
  const notices: Notice[] = []
  if (out.truncated)
    notices.push({
      level: 'info',
      text: `unfiled summary exceeded ${cap} tokens and was truncated`,
    })
  if (out.dropped)
    notices.push({
      level: 'info',
      text: `${out.dropped} malformed condenser proposal(s) dropped`,
    })
  const drafts: NewProposal[] = []
  // `policies.yaml review.drafts: off`: the summary is kept, the proposals are not filed.
  const filed = ctx.config.policies.review.drafts !== 'off'
  for (const p of filed ? out.proposals : []) {
    const block = p.block ?? s.focus.blocks[0]
    if (!block || !(await ctx.backend.read.getBlock(block))) {
      notices.push({
        level: 'info',
        text: `condenser ${p.kind} proposal dropped: no valid block`,
      })
      continue
    }
    drafts.push(condenserProposal(p.kind, block, p.payload))
  }
  const spec = { command: 'session.condense', major: false, target: sessionId }
  await runSystem(ctx, actor, spec, async (t) => {
    const cur = (await t.getSession(sessionId)) ?? s
    const ns: Session = {
      ...cur,
      unfiledSummary: out.summary,
      condensed: args.through,
      counters: bump(cur.counters, {
        [COST.condensations]: 1,
        [COST.condenseTokensIn]: usage.inputTokens,
        [COST.condenseTokensOut]: usage.outputTokens,
      }),
      updatedAt: ctx.clock.now(),
    }
    if (!out.summary) delete ns.unfiledSummary
    delete ns.checkpointRequested
    await t.putSession(ns)
    for (const d of drafts)
      await t.putProposal({
        ...d,
        id: opaqueId('prop'),
        status: 'pending',
        createdAt: ctx.clock.now(),
      })
  })
  return {
    status: 'condensed',
    summaryTokens: tok.count(out.summary),
    proposals: drafts.length,
    notices,
  }
}

/** A condenser proposal as the command it would run, with a note a reviewer can act on. */
function condenserProposal(
  kind: 'decision' | 'thread' | 'progress',
  block: BlockId,
  p: Record<string, unknown>,
): NewProposal {
  const text = (k: string) => String(p[k] ?? '')
  const base = { kind, source: 'condenser' as const, blockId: block }
  if (kind === 'decision')
    return {
      ...base,
      payload: { command: 'decision.record', args: { block, ...p } },
      note: `condenser: the user seems to have decided "${text('title')}": ${text('decision')}`,
    }
  if (kind === 'thread')
    return {
      ...base,
      payload: { command: 'thread.open', args: { block, ...p } },
      note: `condenser: unrecorded discussion "${text('title')}"${p.text ? `: ${text('text')}` : ''}`,
    }
  return {
    ...base,
    payload: { command: 'progress.append', args: { block, ...p } },
    note: `condenser: unrecorded ${text('kind')}: ${text('text')}`,
  }
}
