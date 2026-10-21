// The daemon's brain: maps (method, token) onto Core, keeps per-session notice queues and keeps
// computed focus fresh. All requests run one at a time: Core reads sessions outside transactions,
// so serialising here removes read-modify-write races between clients.
import {
  type Actor,
  authorize,
  type ContextOptions,
  type Core,
  ForbiddenError,
  focusFromPolicy,
  HafizError,
  isAllowed,
  isViewerSession,
  LLMError,
  type LLMRelay,
  type LLMRequest,
  type LLMResult,
  type LLMSettings,
  type Notice,
  nudgeText,
  type Session,
  ValidationError,
} from '@hafiz/core'
import { z } from 'zod'
import { RPC_CODES, RpcFailure, type RpcPeer } from './rpc.js'

export interface QueuedNotice extends Notice {
  /** What produced it: `nudge`, `proposal`, … */
  event: string
  ts: string
}

const QUEUE_CAP = 50
/** Notices kept per session for `notices.peek` (delivered or not). */
const RECENT_CAP = 20

/**
 * Methods that change the store. Sessions of a `read_only` role (the TUI viewer) may call none
 * of them, whatever their tool list says.
 */
const WRITE_METHODS = new Set([
  'dispatch',
  'counters.add',
  'report.capture',
  'condense',
  'checkpoint.request',
  'llm.serve',
])

/**
 * Runs relayed LLM providers (`llm.*.provider: kilo`) in the host plugin that registered for
 * them with `llm.serve`: the daemon sends `llm.complete` back over that plugin's connection. A
 * request for session S goes to the connection S was last served on, so the plugin that owns the
 * Kilo session runs the call (and Kilo bills it to that session's family).
 */
export class LlmRelayHub implements LLMRelay {
  private readonly relays = new Map<RpcPeer, Set<string>>()
  private readonly owners = new Map<string, RpcPeer>()

  register(peer: RpcPeer, providers: string[]): void {
    this.relays.set(peer, new Set(providers))
  }

  /** Session `id` is served on `peer`. */
  own(id: string, peer: RpcPeer): void {
    if (this.owners.get(id) !== peer) this.owners.set(id, peer)
  }

  drop(peer: RpcPeer): void {
    this.relays.delete(peer)
    for (const [id, p] of this.owners) if (p === peer) this.owners.delete(id)
  }

  serves(provider: string): boolean {
    for (const set of this.relays.values()) if (set.has(provider)) return true
    return false
  }

  async complete(
    provider: string,
    settings: LLMSettings,
    req: LLMRequest,
    signal?: AbortSignal,
  ): Promise<LLMResult> {
    const ok = (p: RpcPeer | undefined) => !!p && !!this.relays.get(p)?.has(provider)
    const owner = req.sessionId ? this.owners.get(req.sessionId) : undefined
    const peer = ok(owner)
      ? owner
      : [...this.relays.keys()].find((p) => this.relays.get(p)?.has(provider))
    if (!peer)
      throw new LLMError(
        `llm provider '${provider}' runs inside its host plugin, and none is connected`,
      )
    let out: unknown
    try {
      out = await peer.request(
        'llm.complete',
        { provider, settings: { ...settings }, request: { ...req } },
        { timeoutMs: (settings.timeout_seconds ?? 180) * 1000, ...(signal ? { signal } : {}) },
      )
    } catch (e) {
      throw new LLMError(`${provider}: ${e instanceof Error ? e.message : String(e)}`)
    }
    const r = out as Partial<LLMResult> | null
    if (!r || typeof r.text !== 'string') throw new LLMError(`${provider}: relay returned no text`)
    return { text: r.text, ...(r.usage ? { usage: r.usage } : {}) }
  }
}

const optStr = z.string().optional()
const token = { token: z.string().min(1) }
const ctxOpts = {
  model: optStr,
  budgetTokens: z.number().positive().optional(),
}

const schemas = {
  'session.open': z.object({
    id: z.string().min(1),
    host: z.string().default('unknown'),
    role: z.string().min(1),
    agent: optStr,
    parentSessionId: optStr,
    spawnedBlock: optStr,
    worktree: optStr,
  }),
  dispatch: z.object({
    ...token,
    command: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  'context.for': z.object({ ...token, ...ctxOpts }),
  'context.explain': z.object({ ...token, ...ctxOpts, block: z.string() }),
  'context.delta': z.object(token),
  'block.read': z.object({ ...token, id: z.string(), zoom: optStr }),
  'tree.list': z.object(token),
  'session.status': z.object(token),
  'session.self': z.object(token),
  'project.status': z.object(token),
  'session.end': z.object(token),
  /** Plugin-only system action (not an agent tool, not role-gated): store a subagent's report. */
  'report.capture': z.object({ ...token, block: z.string().min(1), text: z.string().min(1) }),
  'counters.add': z.object({ ...token, delta: z.record(z.string(), z.number()) }),
  'proposal.list': z.object({
    ...token,
    status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  }),
  'notices.drain': z.object(token),
  /** Recent notices of a session (own by default), without draining its queue. */
  'notices.peek': z.object({ ...token, session: optStr }),
  /** The tree with per-block step progress, threads and decisions, plus standing decisions. */
  'tree.summary': z.object({ ...token, recentDecisions: z.number().int().min(0).optional() }),
  /** Doc version history of a block, newest first. */
  'block.history': z.object({
    ...token,
    id: z.string(),
    type: z.enum(['design', 'plan', 'digest']).optional(),
  }),
  /** A host plugin offers to run relayed LLM providers (`kilo`) for the daemon. */
  'llm.serve': z.object({ ...token, providers: z.array(z.string().min(1)).min(1) }),
  /** Fold the turns leaving a session's tail into its unfiled summary (async, may take seconds). */
  condense: z.object({
    ...token,
    turns: z
      .array(
        z.object({
          role: z.string(),
          content: z.string(),
          toolName: optStr,
        }),
      )
      .max(5000),
    through: z.object({ index: z.number().int().min(0), fingerprint: z.string().min(1) }),
  }),
  /** `hafiz checkpoint`: ask sessions to condense at their next shaping. */
  'checkpoint.request': z.object({ ...token, session: optStr }),
} as const

export type DaemonMethod = keyof typeof schemas

/** The session as clients may see it: everything except the capability token. */
export function publicSession(s: Session): Omit<Session, 'token'> {
  const { token: _t, ...rest } = s
  return rest
}

/** Drop `undefined` values: Core's optional fields reject explicit undefined. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

function ctxOf(p: Record<string, unknown>): ContextOptions {
  return compact({ model: p.model, budgetTokens: p.budgetTokens }) as ContextOptions
}

export class DaemonService {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly queues = new Map<string, QueuedNotice[]>()
  private readonly recent = new Map<string, QueuedNotice[]>()
  private readonly nudged = new Map<string, number>()
  /** Command whose last cap rejection a session has not yet retried. */
  private readonly rejected = new Map<string, string>()
  /** Proposals already announced (everything pending at startup counts as old news). */
  private seenProposals = new Set<string>()

  constructor(
    readonly core: Core,
    readonly relay: LlmRelayHub = new LlmRelayHub(),
  ) {}

  /** A client connection closed: it no longer relays anything. */
  disconnected(peer: RpcPeer): void {
    this.relay.drop(peer)
  }

  async init(): Promise<void> {
    for (const p of await this.core.backend.read.listProposals()) this.seenProposals.add(p.id)
  }

  /** Entry point for one RPC call; errors surface as RpcFailure/HafizError for the caller to map. */
  handle(method: string, params: Record<string, unknown>, peer?: RpcPeer): Promise<unknown> {
    // `condense` waits on an LLM for seconds; it must not stall tool calls. Its store writes are
    // single transactions that re-read the session, so running beside the chain is safe.
    if (method === 'condense') return this.exec(method, params, peer)
    const run = this.chain.then(() => this.exec(method, params, peer))
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Resolves once everything accepted so far has finished. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  private async exec(
    method: string,
    raw: Record<string, unknown>,
    peer?: RpcPeer,
  ): Promise<unknown> {
    const schema = schemas[method as DaemonMethod]
    if (!schema)
      throw new RpcFailure({
        code: RPC_CODES.method_not_found,
        message: `unknown method '${method}'`,
      })
    const parsed = schema.safeParse(raw)
    if (!parsed.success)
      throw new RpcFailure({
        code: RPC_CODES.invalid_params,
        message: `invalid params for ${method}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      })
    const p = parsed.data as Record<string, unknown>
    if (method === 'session.open') return this.sessionOpen(p as never)

    const session = await this.authenticate(p.token as string)
    if (WRITE_METHODS.has(method) && this.core.config.roles.roles[session.role]?.read_only)
      throw new ForbiddenError(session.role, method)
    if (peer) this.relay.own(session.id, peer)
    const by: Actor = {
      sessionId: session.id,
      role: session.role,
      ...(session.agent ? { agent: session.agent } : {}),
    }
    const core = this.core
    switch (method as DaemonMethod) {
      case 'dispatch': {
        return this.dispatch(by, p.command as string, p.args as Record<string, unknown>)
      }
      case 'context.for': {
        await this.refreshIfStale(session)
        return core.contextFor(by, ctxOf(p))
      }
      case 'context.explain':
        return core.contextExplain(by, p.block as string, ctxOf(p))
      case 'context.delta':
        return core.contextDelta(by)
      case 'block.read':
        return core.blockRead(by, p.id as string, (p.zoom as string | undefined) ?? 'FULL')
      case 'tree.list':
        return core.treeList(by)
      case 'session.status': {
        authorize(core.config, by.role, 'session.status')
        const fresh = (await core.backend.read.getSession(session.id)) ?? session
        return {
          session: publicSession(fresh),
          epoch: (await core.backend.read.getProject())?.epoch ?? 0,
          pendingNotices: this.queues.get(session.id)?.length ?? 0,
        }
      }
      case 'session.self': {
        // A session's own record (focus, counters, unfiled summary): not role-gated.
        const fresh = (await core.backend.read.getSession(session.id)) ?? session
        return publicSession(fresh)
      }
      case 'project.status': {
        authorize(core.config, by.role, 'session.status')
        const r = core.backend.read
        const project = await r.getProject()
        return {
          project: project && {
            id: project.id,
            name: project.name,
            epoch: project.epoch,
            rootBlockId: project.rootBlockId,
          },
          sessions: (await r.listSessions()).filter((x) => !this.isViewer(x)).map(publicSession),
          pendingProposals: (await r.listProposals({ status: 'pending' })).length,
        }
      }
      case 'session.end': {
        // Last chance to say something: a resumed session finds these in its queue.
        await this.compliance(session.id, 'session_end')
        await core.sessionEnd(session.id)
        return { ended: true }
      }
      case 'report.capture': {
        const r = await core.reportCapture(by, { block: p.block as string, text: p.text as string })
        return r
      }
      case 'counters.add': {
        const s = await core.countersAdd(session.id, p.delta as Record<string, number>)
        if (s) {
          await this.maybeNudge(s)
          await this.compliance(s.id, 'counters')
        }
        return s ? publicSession(s) : null
      }
      case 'condense':
        return this.condense(session, p as never)
      case 'checkpoint.request': {
        // The user (CLI) may name a session; agents may only ask for their own.
        const target = (p.session as string | undefined) ?? session.id
        if (target !== session.id) authorize(core.config, by.role, 'session.checkpoint')
        const live = target === '*' ? await this.activeAgents() : []
        const ids =
          target === '*' ? live.filter((x) => x.id !== session.id).map((x) => x.id) : [target]
        const done: string[] = []
        for (const id of ids) if (await core.checkpointRequest(id)) done.push(id)
        return { requested: done }
      }
      case 'proposal.list': {
        authorize(core.config, by.role, 'proposal.list')
        const status = p.status as 'pending' | 'accepted' | 'rejected' | undefined
        return core.backend.read.listProposals(status ? { status } : undefined)
      }
      case 'notices.drain':
        return this.drainFor(session.id)
      case 'notices.peek': {
        const target = (p.session as string | undefined) ?? session.id
        if (target !== session.id) authorize(core.config, by.role, 'session.status')
        return [...(this.recent.get(target) ?? [])]
      }
      case 'tree.summary':
        return core.treeSummary(
          by,
          typeof p.recentDecisions === 'number' ? { recentDecisions: p.recentDecisions } : {},
        )
      case 'block.history':
        return core.docHistory(by, p.id as string, p.type as never)
      case 'llm.serve': {
        if (!peer) throw new ValidationError('llm.serve needs a socket connection')
        this.relay.register(peer, p.providers as string[])
        return { serving: p.providers }
      }
      default:
        throw new RpcFailure({ code: RPC_CODES.method_not_found, message: 'unknown method' })
    }
  }

  /** One dispatched command, with the bookkeeping compliance and cost need around it. */
  private async dispatch(by: Actor, command: string, args: Record<string, unknown>) {
    const core = this.core
    const sid = by.sessionId
    if (this.rejected.get(sid) === command) {
      this.rejected.delete(sid)
      await core.countersAdd(sid, { retries_after_reject: 1 })
    }
    if (command === 'thread.park' && !(typeof args.gist === 'string' && args.gist.trim()))
      await this.draftGistHint(by, args)
    let out: Awaited<ReturnType<Core['dispatch']>>
    try {
      out = await core.dispatch(by, command, args)
    } catch (e) {
      // a cap rejection: doc sections (cap_exceeded) and log entries (validation with a cap)
      if (
        e instanceof HafizError &&
        (e.code === 'cap_exceeded' || typeof e.details.cap === 'number')
      ) {
        this.rejected.set(sid, command)
        await core.countersAdd(sid, { cap_rejections: 1 })
      }
      throw e
    }
    if (command.startsWith('block.') || command.startsWith('proposal.'))
      await this.afterStatusWrite(sid)
    if (
      command === 'block.request_done' ||
      (command === 'block.set_status' && args.status === 'done')
    ) {
      const extra = await this.compliance(sid, 'request_done', false)
      if (extra.length) out = { ...out, notices: [...out.notices, ...extra] }
      await this.draftDigest(sid, args)
    }
    return out
  }

  /** Thin digest + drafters on: queue a better draft for review. Best effort. */
  private async draftDigest(sid: string, args: Record<string, unknown>): Promise<void> {
    const core = this.core
    const digest = args.digest as Record<string, never> | undefined
    const block = (args.id ?? args.block) as string | undefined
    if (!core.draftersEnabled || !digest || !block || !core.digestIsThin(digest)) return
    try {
      if (await core.draftDigest(sid, block)) await this.announceNewProposals(sid)
    } catch (e) {
      this.enqueue(sid, { level: 'info', text: `digest drafter failed: ${String(e)}` }, 'drafter')
    }
  }

  /** `thread.park` without a gist: hand the agent a draft to submit instead of a bare refusal. */
  private async draftGistHint(by: Actor, args: Record<string, unknown>): Promise<void> {
    const core = this.core
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
  }

  /**
   * Run a compliance hook. Notices go to the session's queue (delivered with its next tool reply
   * or tail shaping) unless `enqueue` is false, in which case they are returned.
   */
  private async compliance(
    sessionId: string,
    when: 'counters' | 'session_end' | 'request_done',
    enqueue = true,
  ): Promise<Notice[]> {
    const { notices, proposals } = await this.core.complianceRun(sessionId, when)
    if (enqueue) for (const n of notices) this.enqueue(sessionId, n, 'compliance')
    if (proposals.length) await this.announceNewProposals(sessionId)
    return enqueue ? [] : notices
  }

  private async condense(
    session: Session,
    p: {
      turns: Array<{ role: string; content: string; toolName?: string | undefined }>
      through: { index: number; fingerprint: string }
    },
  ) {
    const turns = p.turns.map((t) => ({
      role: t.role,
      content: t.content,
      ...(t.toolName ? { toolName: t.toolName } : {}),
    }))
    const r = await this.core.sessionCondense(session.id, { turns, through: p.through })
    for (const n of r.notices) if (n.level === 'warn') this.enqueue(session.id, n, 'condenser')
    if (r.proposals) await this.announceNewProposals(session.id)
    return r
  }

  private async authenticate(token: string): Promise<Session> {
    const s = await this.core.backend.read.getSessionByToken(token)
    if (!s)
      throw new RpcFailure({
        code: RPC_CODES.unauthorized,
        message: 'unknown or revoked token; open a session first',
      })
    if (s.endedAt)
      throw new RpcFailure({
        code: RPC_CODES.unauthorized,
        message: `session ${s.id} has ended; reopen it with session.open`,
      })
    return s
  }

  private async sessionOpen(a: {
    id: string
    host: string
    role: string
    agent?: string
    parentSessionId?: string
    spawnedBlock?: string
    worktree?: string
  }) {
    const prior = await this.core.backend.read.getSession(a.id)
    if (prior && prior.role !== a.role)
      throw new ValidationError(
        `session '${a.id}' already exists with role '${prior.role}'; cannot re-attach as '${a.role}'`,
      )
    const s = await this.core.sessionOpen(compact(a))
    if (prior) await this.refreshIfStale(s)
    // The token is returned here and nowhere else.
    return (await this.core.backend.read.getSession(s.id)) ?? s
  }

  private isViewer(s: Session): boolean {
    return isViewerSession(this.core.config.roles, s)
  }

  /** Live sessions that are agents: the read-only viewer is left out of every agent-facing loop. */
  private async activeAgents(): Promise<Session[]> {
    return (await this.core.backend.read.listSessions({ active: true })).filter(
      (s) => !this.isViewer(s),
    )
  }

  // ───────────────────────── computed focus ─────────────────────────

  /** Refresh one session's computed focus if the policy now yields a different set. */
  private async refreshIfStale(s: Session): Promise<void> {
    if (!s.focus.computed || s.endedAt) return
    if (this.core.config.roles.roles[s.role]?.focus_policy !== 'all_active') return
    const blocks = await this.core.backend.read.listBlocks()
    const want = focusFromPolicy(blocks, 'all_active').blocks
    if (want.length === s.focus.blocks.length && want.every((b, i) => b === s.focus.blocks[i]))
      return
    await this.core.refreshComputedFocus(s.id)
  }

  /** After a block/proposal write: keep every live all_active session's focus current. */
  private async afterStatusWrite(caller: string): Promise<void> {
    for (const s of await this.activeAgents()) await this.refreshIfStale(s)
    await this.announceNewProposals(caller)
  }

  // ───────────────────────── notices ─────────────────────────

  /** Take a session's queued notices (what `notices.drain` does, for in-process callers). */
  drainFor(sessionId: string): QueuedNotice[] {
    const q = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    return q
  }

  enqueue(sessionId: string, n: Notice, event: string): void {
    const item = { ...n, event, ts: this.core.clock.now() }
    const q = this.queues.get(sessionId) ?? []
    q.push(item)
    while (q.length > QUEUE_CAP) q.shift()
    this.queues.set(sessionId, q)
    const r = this.recent.get(sessionId) ?? []
    r.push(item)
    while (r.length > RECENT_CAP) r.shift()
    this.recent.set(sessionId, r)
  }

  /** Tell sessions that can review proposals when a new one lands. */
  private async announceNewProposals(caller: string): Promise<void> {
    const r = this.core.backend.read
    const seen = this.seenProposals
    const fresh = (await r.listProposals({ status: 'pending' })).filter((p) => !seen.has(p.id))
    if (!fresh.length) return
    for (const p of fresh) seen.add(p.id)
    for (const s of await this.activeAgents()) {
      const patterns = this.core.config.roles.roles[s.role]?.tools ?? []
      if (s.id === caller || !isAllowed(patterns, 'proposal.list')) continue
      for (const p of fresh)
        this.enqueue(
          s.id,
          { level: 'info', text: `proposal ${p.id} pending review: ${p.note ?? p.kind}` },
          'proposal',
        )
    }
  }

  /** Tree-less project and a session past a nudge threshold: one line, bounded per session. */
  private async maybeNudge(s: Session): Promise<void> {
    const text = nudgeText(this.core.config.nudge, s.counters, this.nudged.get(s.id) ?? 0)
    if (!text || (await this.core.treeListRaw()).length > 1) return
    this.nudged.set(s.id, (this.nudged.get(s.id) ?? 0) + 1)
    await this.core.countersAdd(s.id, { nudges: 1 })
    this.enqueue(s.id, { level: 'info', text }, 'nudge')
  }
}
