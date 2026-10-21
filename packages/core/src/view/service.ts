// The view queries (§5.2, §6): a session's envelope, its explanation and delta, one block at a
// zoom. Reads are role-gated; the session bookkeeping they record (view hash, delta cursor,
// cost counters) is a system write.

import { authorize } from '../commands/authz.js'
import { bump, type CoreContext, runSystem } from '../commands/tx.js'
import { NotFoundError, ValidationError } from '../domain/errors.js'
import type { Actor, BlockId, Focus, Session } from '../domain/types.js'
import type { Notice } from '../schema/validate.js'
import { COST } from '../session/cost.js'
import { focusFromPolicy } from '../session/service.js'
import { computeDelta, type DeltaResult, deltaScope } from './delta.js'
import {
  buildView,
  type Explanation,
  explain,
  type ManifestEntry,
  readBlock,
  type ViewOptions,
} from './engine.js'
import { parseSelector, resolveView } from './policy.js'
import { loadSnapshot, type Snapshot } from './snapshot.js'

export interface ContextOptions {
  /** Model key into `hafiz.yaml windows`. */
  model?: string
  /** Explicit view budget in tokens. */
  budgetTokens?: number
  /** Render for an ad-hoc session that is never persisted (CLI preview). */
  adhoc?: { role: string; focus?: Focus }
}

export interface ContextView {
  text: string
  hash: string
  floorText: string
  manifest: ManifestEntry[]
  notices: Notice[]
  budget: number
  tokens: number
  /** True when the hash differs from the session's previous view (always true for ad-hoc). */
  changed: boolean
}

/** The largest `progress[-N:]` any zoom asks for: how much progress the snapshot loads. */
function progressDepth(ctx: CoreContext): number {
  let n = 0
  for (const sels of Object.values(ctx.config.zooms.zooms))
    for (const raw of sels) {
      const sel = parseSelector(raw)
      if (sel.kind === 'progress') n = Math.max(n, sel.last)
    }
  return n
}

export async function snapshot(ctx: CoreContext): Promise<Snapshot> {
  return loadSnapshot(ctx.backend.read, { progressLast: progressDepth(ctx) })
}

async function viewSubject(ctx: CoreContext, by: Actor, opts: ContextOptions, snap: Snapshot) {
  if (opts.adhoc) {
    const role = ctx.config.roles.roles[opts.adhoc.role]
    if (!role) throw new ValidationError(`unknown role '${opts.adhoc.role}'`)
    const focus =
      opts.adhoc.focus ??
      focusFromPolicy(
        [...snap.blocks.values()].map((s) => s.block),
        role.focus_policy,
      )
    return { role: opts.adhoc.role, focus, session: null }
  }
  const session = await ctx.backend.read.getSession(by.sessionId)
  if (!session) throw new NotFoundError('session', by.sessionId)
  return { role: session.role, focus: session.focus, session }
}

function viewOptions(role: string, focus: Focus, opts: ContextOptions): ViewOptions {
  return {
    role,
    focus,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.budgetTokens !== undefined ? { budgetTokens: opts.budgetTokens } : {}),
  }
}

/** The session's current envelope text, without recording a view hash. */
export async function envelopeFor(ctx: CoreContext, s: Session): Promise<string> {
  const snap = await snapshot(ctx)
  return buildView(snap, ctx.config, ctx.tok, viewOptions(s.role, s.focus, {})).text
}

/** The session's structured prefix (§6). Records the hash; `changed` drives re-emission. */
export async function contextFor(
  ctx: CoreContext,
  by: Actor,
  opts: ContextOptions = {},
): Promise<ContextView> {
  authorize(ctx.config, by.role, 'context.for')
  const snap = await snapshot(ctx)
  const { role, focus, session } = await viewSubject(ctx, by, opts, snap)
  const v = buildView(snap, ctx.config, ctx.tok, viewOptions(role, focus, opts))
  const changed = v.hash !== session?.lastViewHash
  if (session && (changed || session.deltaCursor === undefined)) {
    const cursor = session.deltaCursor ?? (await ctx.backend.read.currentSeq())
    const spec = { command: 'context.for', major: false, target: session.id }
    await runSystem(ctx, by, spec, async (t) => {
      const cur = (await t.getSession(session.id)) ?? session
      await t.putSession({
        ...cur,
        counters: changed
          ? bump(cur.counters, { [COST.viewEmits]: 1, [COST.viewTokens]: v.tokens })
          : cur.counters,
        lastViewHash: v.hash,
        deltaCursor: cur.deltaCursor ?? cursor,
        updatedAt: ctx.clock.now(),
      })
    })
  }
  return {
    text: v.text,
    hash: v.hash,
    floorText: v.floorText,
    manifest: v.manifest,
    notices: v.notices,
    budget: v.budget,
    tokens: v.tokens,
    changed,
  }
}

/** Which rule fired for a block, how it aggregated, which degrade steps touched it. */
export async function contextExplain(
  ctx: CoreContext,
  by: Actor,
  blockId: BlockId,
  opts: ContextOptions = {},
): Promise<Explanation> {
  authorize(ctx.config, by.role, 'context.explain')
  const snap = await snapshot(ctx)
  const { role, focus } = await viewSubject(ctx, by, opts, snap)
  const v = buildView(snap, ctx.config, ctx.tok, viewOptions(role, focus, opts))
  return explain(v, snap, blockId)
}

/** Minor events on focus + dependencies since the last delivery; advances the cursor. */
export async function contextDelta(ctx: CoreContext, by: Actor): Promise<DeltaResult> {
  authorize(ctx.config, by.role, 'context.delta')
  const session = await ctx.backend.read.getSession(by.sessionId)
  if (!session) throw new NotFoundError('session', by.sessionId)
  const snap = await snapshot(ctx)
  const role = ctx.config.roles.roles[session.role]
  const view = resolveView(ctx.config, role?.view ?? 'default')
  const start = session.deltaCursor ?? (await ctx.backend.read.currentSeq())
  const d = await computeDelta(ctx.backend.read, {
    cursor: start,
    blocks: deltaScope(snap, session.focus.blocks, view.dependencyDepth),
    capTokens: ctx.config.tail.delta.cap_tokens,
    tokenizer: ctx.tok,
    sessionId: session.id,
  })
  if (d.cursor !== session.deltaCursor) {
    const spec = { command: 'context.delta', major: false, target: session.id }
    await runSystem(ctx, by, spec, async (t) => {
      const cur = (await t.getSession(session.id)) ?? session
      await t.putSession({
        ...cur,
        counters: d.text
          ? bump(cur.counters, { [COST.deltaTokens]: ctx.tok.count(d.text) })
          : cur.counters,
        deltaCursor: d.cursor,
        updatedAt: ctx.clock.now(),
      })
    })
  }
  return d
}

/** One block rendered at a zoom level. */
export async function blockRead(
  ctx: CoreContext,
  by: Actor,
  id: BlockId,
  zoom = 'FULL',
): Promise<string> {
  authorize(ctx.config, by.role, 'block.read')
  const snap = await snapshot(ctx)
  if (!snap.blocks.has(id)) throw new NotFoundError('block', id)
  return readBlock(snap, ctx.config, id, zoom)
}
