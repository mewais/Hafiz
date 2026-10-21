// Running the compliance engine (compliance.ts) against a session: bring its bookkeeping up to
// date from the store, evaluate one hook, persist the edge state, queue the proposals.

import { type NewProposal, proposalAdd } from '../commands/proposals.js'
import { type CoreContext, runSystem } from '../commands/tx.js'
import type { ComplianceState, ProgressEntry, Proposal, Session, Thread } from '../domain/types.js'
import type { Notice } from '../schema/validate.js'
import {
  type ComplianceCheck,
  type ComplianceEngine,
  type ComplianceWhen,
  complianceProposals,
  initialState,
  type ProposalDraft,
  renderMessage,
} from './compliance.js'
import { countersAdd } from './service.js'

/** Bring the session's compliance bookkeeping up to date from the store (incremental). */
async function complianceState(
  ctx: CoreContext,
  s: Session,
): Promise<{ state: ComplianceState; openThreads: Thread[] }> {
  const r = ctx.backend.read
  const state: ComplianceState = {
    ...(s.compliance ?? initialState()),
    active: [...(s.compliance?.active ?? [])],
  }
  const turns = s.counters.turns ?? 0
  for (;;) {
    const rows = await r.readSince(state.seq, 500)
    for (const row of rows) {
      if (row.log === 'progress' && (row.entry as ProgressEntry).by.sessionId === s.id)
        state.progress++
      state.seq = Math.max(state.seq, row.seq)
    }
    if (rows.length < 500) break
  }
  const mine = (await r.listThreads()).filter((t) => t.by.sessionId === s.id)
  if (state.progress > (s.compliance?.progress ?? 0)) state.progressTurn = turns
  if (mine.length > state.threads) state.userTurnsAtThread = s.counters.user_turns ?? 0
  state.threads = mine.length
  return { state, openThreads: mine.filter((t) => t.status === 'open') }
}

/**
 * Evaluate the compliance checks of one hook for a session. Returns the notices to show the
 * session and the proposals queued for review. Each check fires once per false→true change.
 */
export async function complianceRun(
  ctx: CoreContext,
  engine: ComplianceEngine,
  sessionId: string,
  when: ComplianceWhen,
): Promise<{ notices: Notice[]; proposals: Proposal[] }> {
  const none = { notices: [] as Notice[], proposals: [] as Proposal[] }
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s || !engine.forHook(when).length) return none
  const { state, openThreads } = await complianceState(ctx, s)
  const focused = s.focus.blocks.length > 0
  const metrics: Record<string, number> = {
    ...s.counters,
    progress: state.progress,
    turns_since_progress: focused ? (s.counters.turns ?? 0) - state.progressTurn : 0,
    threads_opened_open: openThreads.length,
    user_turns_on_focus_without_thread: focused
      ? (s.counters.user_turns ?? 0) - state.userTurnsAtThread
      : 0,
  }
  const { fired, active } = engine.evaluate(when, metrics, state.active)
  state.active = active
  const by = { sessionId, role: s.role }
  const changed = JSON.stringify(state) !== JSON.stringify(s.compliance)
  if (changed)
    await runSystem(
      ctx,
      by,
      { command: 'session.compliance', major: false, target: sessionId },
      async (t) => {
        const cur = (await t.getSession(sessionId)) ?? s
        await t.putSession({ ...cur, compliance: state })
      },
    )
  const notices: Notice[] = []
  const proposals: Proposal[] = []
  for (const f of fired) {
    if (f.check.action.includes('notice'))
      notices.push({
        level: 'warn',
        text: renderMessage(f.check.message ?? defaultMessage(f.check), metrics),
      })
    if (f.check.action.includes('proposal'))
      for (const d of complianceProposals(f.check.id, {
        sessionId,
        block: s.focus.blocks[0],
        openThreads,
        metrics,
      }))
        proposals.push(await proposalAdd(ctx, proposalOf(d), by))
  }
  // measurable for the compliance harness (M6): how often the engine spoke to this session
  if (notices.length) await countersAdd(ctx, sessionId, { compliance_notices: notices.length })
  return { notices, proposals }
}

function defaultMessage(c: ComplianceCheck): string {
  return `Hafiz compliance check '${c.id}' tripped (${c.cond}).`
}

function proposalOf(d: ProposalDraft): NewProposal {
  return {
    kind: d.kind,
    source: 'compliance',
    ...(d.blockId ? { blockId: d.blockId } : {}),
    payload: d.payload,
    note: d.note,
  }
}
