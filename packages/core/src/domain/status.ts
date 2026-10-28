import type { Config } from '../config/schema.js'
import { GuardError, InvalidTransitionError } from './errors.js'
import type { Block, BlockedOn, Doc, ReviewMode, Status, Thread } from './types.js'

/** Everything a guard may need. Commands assemble it; guards stay pure. */
export interface TransitionContext {
  block: Block
  to: Status
  children: Block[]
  threads: Thread[]
  digest: Doc | null
  args: {
    digestProvided?: boolean
    reason?: string
    blockedOn?: BlockedOn
    confirmed?: boolean
  }
  /** `policies.yaml review.done`: `gate` holds the transition until confirmed. */
  doneReview: ReviewMode
}

export type GuardResult =
  | { ok: true }
  | { ok: false; error: GuardError }
  | { needsConfirmation: true }
export type Guard = (ctx: TransitionContext) => GuardResult

const ok: GuardResult = { ok: true }
const fail = (guard: string, msg: string, details?: Record<string, unknown>): GuardResult => ({
  ok: false,
  error: new GuardError(guard, msg, details),
})

/** Built-in guard predicates, referenced by name from policies.yaml. Extension point. */
export const builtinGuards: Record<string, Guard> = {
  digest_present_and_fresh: (c) => {
    if (!c.digest && !c.args.digestProvided)
      return fail(
        'digest_present_and_fresh',
        'a digest is required to mark a block done: pass `digest` with the status.',
      )
    if (c.block.digestStale && !c.args.digestProvided)
      return fail(
        'digest_present_and_fresh',
        'this block was reopened; its digest is stale. Supply a fresh digest with this call.',
      )
    return ok
  },
  no_open_threads: (c) => {
    const open = c.threads.filter((t) => t.status === 'open')
    return open.length
      ? fail(
          'no_open_threads',
          `block has ${open.length} open thread(s): ${open.map((t) => `${t.id} "${t.title}"`).join(', ')}. Park (with a gist) or resolve them first.`,
          { threads: open.map((t) => t.id) },
        )
      : ok
  },
  children_closed: (c) => {
    const openKids = c.children.filter((k) => k.status !== 'done' && k.status !== 'dropped')
    return openKids.length
      ? fail(
          'children_closed',
          `child block(s) not closed: ${openKids.map((k) => `${k.id} [${k.status}]`).join(', ')}. Finish or drop them first.`,
          { children: openKids.map((k) => k.id) },
        )
      : ok
  },
  review_done: (c) =>
    c.doneReview === 'gate' && !c.args.confirmed ? { needsConfirmation: true } : ok,
  blocked_on_required: (c) =>
    c.args.blockedOn
      ? ok
      : fail(
          'blocked_on_required',
          '`blocked_on` is required: what is this block waiting on (block | thread | user | external)?',
        ),
  reason_required: (c) =>
    c.args.reason?.trim()
      ? ok
      : fail(
          'reason_required',
          'a `reason` is required for this transition; it is recorded as a decision.',
        ),
}

export interface TransitionOutcome {
  /** True when the transition may proceed now. */
  proceed: boolean
  needsConfirmation: boolean
}

export class StatusMachine {
  private readonly transitions: Record<string, string[]>
  private readonly guardLists: Record<string, string[]>
  private readonly activatedBy: string[]
  constructor(
    policy: Config['policies']['status'],
    private readonly guards: Record<string, Guard> = builtinGuards,
  ) {
    this.transitions = policy.transitions
    this.guardLists = policy.guards
    this.activatedBy = policy.activate_on_spawn ?? []
  }

  canTransition(from: Status, to: Status): boolean {
    return (this.transitions[from] ?? []).includes(to)
  }

  /** Throws InvalidTransitionError / GuardError; returns needsConfirmation when a guard asks for it. */
  check(ctx: TransitionContext): TransitionOutcome {
    const from = ctx.block.status
    if (!this.canTransition(from, ctx.to))
      throw new InvalidTransitionError(from, ctx.to, this.transitions[from] ?? [], this.activatedBy)
    const key = from === 'done' && ctx.to === 'active' ? 'reopen' : `to_${ctx.to}`
    let needsConfirmation = false
    for (const name of this.guardLists[key] ?? []) {
      const g = this.guards[name]
      if (!g) throw new GuardError(name, `unknown guard '${name}' in policies.yaml`)
      const r = g(ctx)
      if ('needsConfirmation' in r) needsConfirmation = true
      else if (!r.ok) throw r.error
    }
    return { proceed: !needsConfirmation, needsConfirmation }
  }
}
