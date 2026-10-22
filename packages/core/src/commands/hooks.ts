// What Core does around a dispatched command, beyond the command itself: the hooks a catalogue
// entry declares (`before`/`after` in catalogue.ts). They run only on `dispatch`, never when a
// command is called directly or performed by proposal acceptance. Anything aimed at other
// sessions or a session's notice queue goes to the gateway through the `DispatchSink`.

import { ValidationError } from '../domain/errors.js'
import { reviewVersion } from '../domain/review.js'
import { type Actor, type Block, REVIEW_TYPES, type SectionValue } from '../domain/types.js'
import type { Notice } from '../schema/validate.js'
import type { AfterHook, BeforeHook } from './catalogue.js'
import type { Core } from './core.js'

/** The gateway's side of a dispatch: where notices and announcements go. */
export interface DispatchSink {
  /** New proposals may be pending: announce them to the sessions that review them. */
  proposalsAdded(): Promise<void>
  /** A notice for the caller's queue (its next tool reply), not for this reply. */
  enqueue(n: Notice, event: string): void
  /** A notice for the sessions that run the review queue (the manager), other than the caller. */
  notifyReviewers(n: Notice, event: string): Promise<void>
}

export const NO_SINK: DispatchSink = {
  proposalsAdded: async () => undefined,
  enqueue: () => undefined,
  notifyReviewers: async () => undefined,
}

export interface HookCall {
  by: Actor
  command: string
  args: Record<string, unknown>
  sink: DispatchSink
  /** The command's result (after-hooks only). */
  result?: unknown
}

type HookHost = Pick<
  Core,
  | 'draftersEnabled'
  | 'draftGist'
  | 'digestIsThin'
  | 'draftDigest'
  | 'complianceRun'
  | 'refreshAgentFocus'
  | 'reviewFileCreated'
  | 'backend'
>

/** `request_done`, or `set_status` to done: a request to finish a block. */
const marksDone = (c: HookCall) => c.command !== 'block.set_status' || c.args.status === 'done'

export const BEFORE_HOOKS: Record<BeforeHook, (core: HookHost, c: HookCall) => Promise<void>> = {
  /** `thread.park` without a gist: hand the agent a draft to submit instead of a bare refusal. */
  async draft_gist(core, { by, args }) {
    if (typeof args.gist === 'string' && args.gist.trim()) return
    if (!core.draftersEnabled || typeof args.id !== 'string') return
    try {
      const d = await core.draftGist(by.sessionId, args.id)
      if (d)
        throw new ValidationError(
          `a gist is required to park a thread: what was being discussed and where it stands. Draft (submit it if accurate, else fix it): ${JSON.stringify(d.gist)}`,
        )
    } catch (e) {
      if (e instanceof ValidationError) throw e
    }
  },
}

/** After-hooks may return notices, which join the command's reply. */
export const AFTER_HOOKS: Record<
  AfterHook,
  (core: HookHost, c: HookCall) => Promise<Notice[] | undefined>
> = {
  async refresh_focus(core) {
    await core.refreshAgentFocus()
    return undefined
  },

  async announce_proposals(_core, { sink }) {
    await sink.proposalsAdded()
    return undefined
  },

  /** `block.create` with an inline design or plan by a non-approver: file their reviews. */
  async file_reviews(core, c) {
    const block = (c.result as Block | undefined)?.id
    const types = REVIEW_TYPES.filter((t) => c.args[t] !== undefined)
    if (!block || !types.length) return undefined
    if ((await core.reviewFileCreated(c.by, block, types)).length) await c.sink.proposalsAdded()
    return undefined
  },

  /** A design/plan review resolved, or any proposal rejected with a note: tell the reviewers. */
  async announce_resolution(core, c) {
    const p = (await core.backend.read.listProposals()).find((x) => x.id === c.args.id)
    if (!p || p.status === 'pending' || (p.source !== 'review' && !p.resolutionNote))
      return undefined
    const b = p.blockId ? await core.backend.read.getBlock(p.blockId) : null
    const what =
      p.source === 'review'
        ? `${p.kind} v${reviewVersion(p)} of '${b?.title ?? p.blockId}' [${p.blockId}]`
        : `proposal ${p.id} (${p.kind}${b ? ` on '${b.title}'` : ''})`
    const verdict = p.status === 'accepted' ? 'approved' : 'rejected'
    const why = p.resolutionNote ? `: ${p.resolutionNote}` : ''
    await c.sink.notifyReviewers(
      {
        level: p.status === 'accepted' ? 'info' : 'warn',
        text: `${what} ${verdict} by ${c.by.role}${why}`,
      },
      'review',
    )
    return undefined
  },

  async done_compliance(core, c) {
    if (!marksDone(c)) return undefined
    const { notices, proposals } = await core.complianceRun(c.by.sessionId, 'request_done')
    if (proposals.length) await c.sink.proposalsAdded()
    return notices
  },

  /** Thin digest + drafters on: queue a better draft for review. Best effort. */
  async draft_digest(core, c) {
    if (!marksDone(c)) return undefined
    const sid = c.by.sessionId
    const digest = c.args.digest as Record<string, SectionValue> | undefined
    const block = (c.args.id ?? c.args.block) as string | undefined
    if (!core.draftersEnabled || !digest || !block || !core.digestIsThin(digest)) return undefined
    try {
      if (await core.draftDigest(sid, block)) await c.sink.proposalsAdded()
    } catch (e) {
      c.sink.enqueue({ level: 'info', text: `digest drafter failed: ${String(e)}` }, 'drafter')
    }
    return undefined
  },
}
