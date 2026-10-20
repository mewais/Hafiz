// Compliance engine (§7): mechanical checks over session counters and derived metrics, evaluated
// on counter updates, at request_done and at session end. No LLM. Each check is edge-triggered:
// it fires when its condition becomes true and not again until it has been false, so a session is
// told once per state change, never nagged.
import type { Config } from '../config/schema.js'
import type { ComplianceState } from '../domain/types.js'
import { type Expr, evalExpr, parseExpr } from './expr.js'

export type ComplianceCheck = Config['compliance']['checks'][number]
export type ComplianceWhen = ComplianceCheck['when']

/** Metrics a condition may read, besides every raw session counter (unknown names read as 0). */
export const DERIVED_METRICS = [
  'progress',
  'turns_since_progress',
  'threads_opened_open',
  'user_turns_on_focus_without_thread',
] as const

export interface Fired {
  check: ComplianceCheck
  metrics: Record<string, number>
}

export function initialState(seq = 0): ComplianceState {
  return { active: [], seq, progress: 0, progressTurn: 0, threads: 0, userTurnsAtThread: 0 }
}

export class ComplianceEngine {
  private readonly parsed = new Map<string, Expr>()

  constructor(private readonly checks: readonly ComplianceCheck[]) {
    for (const c of checks) this.parsed.set(c.id, parseExpr(c.cond)) // throws on a bad config
  }

  /** Checks to evaluate for one hook. */
  forHook(when: ComplianceWhen): ComplianceCheck[] {
    return this.checks.filter((c) => c.when === when)
  }

  /**
   * Evaluate the checks of one hook. Returns the checks that fired and the new `active` list
   * (checks of other hooks keep their state).
   */
  evaluate(
    when: ComplianceWhen,
    metrics: Record<string, number>,
    active: readonly string[],
  ): { fired: Fired[]; active: string[] } {
    const next = new Set(active)
    const fired: Fired[] = []
    for (const c of this.forHook(when)) {
      const holds = evalExpr(this.parsed.get(c.id) as Expr, metrics)
      if (holds && !next.has(c.id)) {
        fired.push({ check: c, metrics })
        next.add(c.id)
      } else if (!holds) next.delete(c.id)
    }
    return { fired, active: [...next] }
  }
}

/** `{metric}` placeholders filled from the metrics. */
export function renderMessage(template: string, metrics: Readonly<Record<string, number>>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(metrics[k] ?? 0))
}

export interface ProposalContext {
  sessionId: string
  /** First focus block, if any. */
  block?: string | undefined
  /** Threads this session opened that are still open. */
  openThreads: ReadonlyArray<{ id: string; blockId: string; title: string }>
  metrics: Readonly<Record<string, number>>
}

export interface ProposalDraft {
  kind: 'progress' | 'thread'
  blockId?: string
  payload: { command: string; args: Record<string, unknown> }
  note: string
}

/** The concrete command a `proposal` action suggests, per check. Unknown checks: none. */
export function complianceProposals(checkId: string, ctx: ProposalContext): ProposalDraft[] {
  switch (checkId) {
    case 'wrote_without_progress': {
      if (!ctx.block) return []
      const n = ctx.metrics.files_written ?? 0
      const text = `Session ${ctx.sessionId} wrote ${n} file${n === 1 ? '' : 's'} without recording progress.`
      return [
        {
          kind: 'progress',
          blockId: ctx.block,
          payload: { command: 'progress.append', args: { block: ctx.block, kind: 'report', text } },
          note: `compliance: ${text}`,
        },
      ]
    }
    case 'open_threads_at_exit':
      return ctx.openThreads.map((t) => ({
        kind: 'thread' as const,
        blockId: t.blockId,
        payload: {
          command: 'thread.park',
          args: {
            id: t.id,
            gist: `Left open when session ${ctx.sessionId} ended; resume to continue "${t.title}".`,
          },
        },
        note: `compliance: thread "${t.title}" was still open when session ${ctx.sessionId} ended; park it?`,
      }))
    default:
      return []
  }
}
