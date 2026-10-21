// Sessions (§7): open/re-attach, end, counters, and focus (explicit `focus.set` or computed from
// the role's focus policy). Everything but `focus.set` is Hafiz's own bookkeeping (system writes).

import {
  bump,
  type CommandResult,
  type CoreContext,
  mustBlock,
  runAs,
  runSystem,
} from '../commands/tx.js'
import { isViewerSession } from '../config/schema.js'
import { NotFoundError, ValidationError } from '../domain/errors.js'
import { token as mintToken } from '../domain/ids.js'
import type { Actor, Block, BlockId, Focus, Session } from '../domain/types.js'
import type { WriteOps } from '../store/backend.js'
import { initialState } from './compliance.js'

/** Focus from a role's focus policy, computed over the current blocks. */
export function focusFromPolicy(
  blocks: readonly Block[],
  policy: string,
  spawned?: BlockId,
): Focus {
  if (policy === 'spawned_block' && spawned) return { blocks: [spawned], computed: true }
  if (policy === 'all_active') {
    const active = [...blocks]
      .filter((b) => b.status === 'active' && b.parentId !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return { blocks: active.map((b) => b.id), computed: true }
  }
  return { blocks: [], computed: true }
}

async function computeFocus(t: WriteOps, policy: string, spawned?: BlockId): Promise<Focus> {
  return focusFromPolicy(await t.listBlocks(), policy, spawned)
}

/** The actor a session's own bookkeeping writes are attributed to. */
const self = (s: Session): Actor => ({ sessionId: s.id, role: s.role })

export interface SessionOpenArgs {
  id: string
  host: string
  role: string
  agent?: string
  parentSessionId?: string
  spawnedBlock?: BlockId
  /** Working tree the session runs in (git top level of its cwd). */
  worktree?: string
}

/** Open (or re-attach to) a session. Not role-gated: gateways call it before any role exists. */
export async function sessionOpen(ctx: CoreContext, args: SessionOpenArgs): Promise<Session> {
  const existing = await ctx.backend.read.getSession(args.id)
  const role = ctx.config.roles.roles[args.role]
  if (!role) throw new ValidationError(`unknown role '${args.role}'`)
  const by: Actor = {
    sessionId: args.id,
    role: args.role,
    ...(args.agent ? { agent: args.agent } : {}),
  }
  const spec = { command: 'session.open', major: false, target: args.id }
  const { result } = await runSystem(ctx, by, spec, async (t) => {
    const now = ctx.clock.now()
    if (existing) {
      const s: Session = { ...((await t.getSession(args.id)) ?? existing), updatedAt: now }
      delete s.endedAt
      if (args.worktree) s.worktree = args.worktree
      await t.putSession(s)
      return s
    }
    const focus = await computeFocus(t, role.focus_policy, args.spawnedBlock)
    const s: Session = {
      id: args.id,
      projectId: (await t.getProject())?.id ?? '',
      host: args.host,
      role: args.role,
      ...(args.agent ? { agent: args.agent } : {}),
      token: mintToken(),
      ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
      ...(args.worktree ? { worktree: args.worktree } : {}),
      focus,
      counters: {},
      compliance: initialState(await t.currentSeq()),
      createdAt: now,
      updatedAt: now,
    }
    await t.putSession(s)
    return s
  })
  return result
}

export async function sessionEnd(ctx: CoreContext, sessionId: string): Promise<void> {
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s) return
  const spec = { command: 'session.end', major: false, target: sessionId }
  await runSystem(ctx, self(s), spec, async (t) => {
    const cur = (await t.getSession(sessionId)) ?? s
    await t.putSession({ ...cur, endedAt: ctx.clock.now(), updatedAt: ctx.clock.now() })
  })
}

export async function countersAdd(
  ctx: CoreContext,
  sessionId: string,
  delta: Record<string, number>,
): Promise<Session | null> {
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s) return null
  const spec = { command: 'session.counters', major: false, target: sessionId }
  const { result } = await runSystem(ctx, self(s), spec, async (t) => {
    // re-read inside the transaction: condensation and compliance write the session too
    const cur = (await t.getSession(sessionId)) ?? s
    const ns = { ...cur, counters: bump(cur.counters, delta), updatedAt: ctx.clock.now() }
    await t.putSession(ns)
    return ns
  })
  return result
}

export interface FocusSetArgs {
  blocks: BlockId[]
  order?: BlockId[]
}

export async function focusSet(
  ctx: CoreContext,
  by: Actor,
  args: FocusSetArgs,
): Promise<CommandResult<Session>> {
  const spec = { command: 'focus.set', major: false, target: by.sessionId }
  return runAs(ctx, by, spec, async (t) => {
    const s = await t.getSession(by.sessionId)
    if (!s) throw new NotFoundError('session', by.sessionId)
    for (const id of args.blocks) await mustBlock(t, id)
    const ns: Session = {
      ...s,
      focus: {
        blocks: args.blocks,
        ...(args.order ? { order: args.order } : {}),
        computed: false,
      },
      updatedAt: ctx.clock.now(),
    }
    await t.putSession(ns)
    return ns
  })
}

/** Re-evaluate a computed focus (e.g. a new block became active) without touching explicit ones. */
export async function refreshComputedFocus(
  ctx: CoreContext,
  sessionId: string,
): Promise<Session | null> {
  const s = await ctx.backend.read.getSession(sessionId)
  if (!s?.focus.computed) return s
  const role = ctx.config.roles.roles[s.role]
  if (role?.focus_policy !== 'all_active') return s
  const spec = { command: 'session.focus_refresh', major: false, target: sessionId }
  const { result } = await runSystem(ctx, self(s), spec, async (t) => {
    const ns = {
      ...((await t.getSession(sessionId)) ?? s),
      focus: await computeFocus(t, 'all_active'),
      updatedAt: ctx.clock.now(),
    }
    await t.putSession(ns)
    return ns
  })
  return result
}

/** Live sessions that are agents: the read-only viewer is left out of every agent-facing loop. */
export async function activeAgents(ctx: CoreContext): Promise<Session[]> {
  return (await ctx.backend.read.listSessions({ active: true })).filter(
    (s) => !isViewerSession(ctx.config.roles, s),
  )
}

/** Refresh one session's computed focus if the policy now yields a different set. */
export async function refreshStaleFocus(ctx: CoreContext, s: Session): Promise<void> {
  if (!s.focus.computed || s.endedAt) return
  if (ctx.config.roles.roles[s.role]?.focus_policy !== 'all_active') return
  const blocks = await ctx.backend.read.listBlocks()
  const want = focusFromPolicy(blocks, 'all_active').blocks
  if (want.length === s.focus.blocks.length && want.every((b, i) => b === s.focus.blocks[i])) return
  await refreshComputedFocus(ctx, s.id)
}

/** Keep every live agent's computed focus current (after a block or proposal write). */
export async function refreshAgentFocus(ctx: CoreContext): Promise<void> {
  for (const s of await activeAgents(ctx)) await refreshStaleFocus(ctx, s)
}
