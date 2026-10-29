// The daemon's brain: maps (method, token) onto Core, keeps per-session notice queues and keeps
// computed focus fresh. All requests run one at a time: Core reads sessions outside transactions,
// so serialising here removes read-modify-write races between clients.
import {
  type Actor,
  authorize,
  type ContextOptions,
  type Core,
  type DispatchSink,
  ForbiddenError,
  HafizError,
  isAllowed,
  isViewerSession,
  LLMError,
  type LLMRelay,
  type LLMRequest,
  type LLMResult,
  type LLMSettings,
  mayApprove,
  type Notice,
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
  'system.progress',
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
  /** The commands the caller's session ran since it opened, as audited (`block.request_done`, `progress.append:blocked`, …). */
  'session.activity': z.object(token),
  'project.status': z.object(token),
  'session.end': z.object(token),
  /** Plugin-only system action (not an agent tool, not role-gated): a subagent's report, or a `changed` note. */
  'system.progress': z.object({
    ...token,
    block: z.string().min(1),
    kind: z.enum(['report', 'changed']),
    text: z.string().min(1),
  }),
  'counters.add': z.object({ ...token, delta: z.record(z.string(), z.number()) }),
  'proposal.list': z.object({
    ...token,
    status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  }),
  /**
   * The review queue as `hafiz review` and the TUI list it: each proposal with its
   * `policies.yaml review` row (`mode`), block title and, for design/plan reviews, the version.
   * Default: pending.
   */
  'review.list': z.object({
    ...token,
    status: z.enum(['pending', 'accepted', 'rejected', 'all']).optional(),
    /** Only what the session's role may resolve (the agent tool's list). */
    resolvable: z.boolean().optional(),
  }),
  /** One proposal and the doc it is about, at the version under review (`hafiz review --show`). */
  'review.show': z.object({ ...token, id: z.string().min(1) }),
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
/** A method's params after validation. */
type Params<M extends DaemonMethod> = z.infer<(typeof schemas)[M]>

/** The session as clients may see it: everything except the capability token. */
export function publicSession(s: Session): Omit<Session, 'token'> {
  const { token: _t, ...rest } = s
  return rest
}

/** Drop `undefined` values: Core's optional fields reject explicit undefined. */
function compact<T extends object>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>
  }
}

function ctxOf(p: Record<string, unknown>): ContextOptions {
  return compact({ model: p.model, budgetTokens: p.budgetTokens }) as ContextOptions
}

export class DaemonService {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly queues = new Map<string, QueuedNotice[]>()
  private readonly recent = new Map<string, QueuedNotice[]>()
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
    if (method === 'session.open') return this.sessionOpen(p as Params<'session.open'>)

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
        await this.core.refreshStaleFocus(session)
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
      case 'session.activity': {
        // Own record only, like session.self: not role-gated.
        const since = session.createdAt
        const audit = await core.backend.read.readAudit()
        return {
          commands: audit
            .filter((a) => a.by.sessionId === session.id && a.ts >= since)
            .map((a) => a.command),
        }
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
      case 'system.progress':
        return core.systemProgress(by, {
          block: p.block as string,
          kind: p.kind as 'report' | 'changed',
          text: p.text as string,
        })
      case 'counters.add': {
        const s = await core.countersAdd(session.id, p.delta as Record<string, number>)
        if (s) await this.compliance(s.id, 'counters')
        return s ? publicSession(s) : null
      }
      case 'condense':
        return this.condense(session, p as Params<'condense'>)
      case 'checkpoint.request': {
        // The user (CLI) may name a session; agents may only ask for their own.
        const target = (p.session as string | undefined) ?? session.id
        if (target !== session.id) authorize(core.config, by.role, 'session.checkpoint')
        const live = target === '*' ? await this.core.activeAgents() : []
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
      case 'review.list':
        return core.reviewList(
          by,
          p.status as Params<'review.list'>['status'],
          p.resolvable as boolean | undefined,
        )
      case 'review.show':
        return core.reviewShow(by, p.id as string)
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
        return core.docHistory(by, p.id as string, p.type as Params<'block.history'>['type'])
      case 'llm.serve': {
        if (!peer) throw new ValidationError('llm.serve needs a socket connection')
        this.relay.register(peer, p.providers as string[])
        return { serving: p.providers }
      }
      default:
        throw new RpcFailure({ code: RPC_CODES.method_not_found, message: 'unknown method' })
    }
  }

  /**
   * One dispatched command. Core runs the command's own hooks (focus refresh, compliance at
   * request_done, drafters); the daemon adds what only it can: cap-rejection and retry counters,
   * the caller's notice queue, and proposal announcements to other sessions.
   */
  private async dispatch(by: Actor, command: string, args: Record<string, unknown>) {
    const core = this.core
    const sid = by.sessionId
    if (this.rejected.get(sid) === command) {
      this.rejected.delete(sid)
      await core.countersAdd(sid, { retries_after_reject: 1 })
    }
    const sink: DispatchSink = {
      proposalsAdded: () => this.announceNewProposals(sid),
      enqueue: (n, event) => this.enqueue(sid, n, event),
      notifyReviewers: (n, event) => this.notifyReviewers(sid, n, event),
    }
    try {
      return await core.dispatch(by, command, args, sink)
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

  private async condense(session: Session, p: Params<'condense'>) {
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

  private async sessionOpen(a: Params<'session.open'>) {
    const prior = await this.core.backend.read.getSession(a.id)
    if (prior && prior.role !== a.role)
      throw new ValidationError(
        `session '${a.id}' already exists with role '${prior.role}'; cannot re-attach as '${a.role}'`,
      )
    const s = await this.core.sessionOpen(compact(a))
    if (prior) await this.core.refreshStaleFocus(s)
    // The token is returned here and nowhere else.
    return (await this.core.backend.read.getSession(s.id)) ?? s
  }

  private isViewer(s: Session): boolean {
    return isViewerSession(this.core.config.roles, s)
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

  /** Live agents that run the review queue (they may list proposals), other than `caller`. */
  private async reviewers(caller: string): Promise<Session[]> {
    return (await this.core.activeAgents()).filter(
      (s) =>
        s.id !== caller &&
        isAllowed(this.core.config.roles.roles[s.role]?.tools ?? [], 'proposal.list'),
    )
  }

  /** A notice for the reviewers' queues (a review resolved, a rejection's note). */
  private async notifyReviewers(caller: string, n: Notice, event: string): Promise<void> {
    for (const s of await this.reviewers(caller)) this.enqueue(s.id, n, event)
  }

  /**
   * Tell sessions that can review proposals when a new one lands. Design and plan reviews go
   * only to roles that may approve them (`policies.yaml review.approver`).
   */
  private async announceNewProposals(caller: string): Promise<void> {
    const r = this.core.backend.read
    const seen = this.seenProposals
    const fresh = (await r.listProposals({ status: 'pending' })).filter((p) => !seen.has(p.id))
    if (!fresh.length) return
    for (const p of fresh) seen.add(p.id)
    const policy = this.core.config.policies.review
    for (const s of await this.reviewers(caller))
      for (const p of fresh)
        if (p.source !== 'review' || mayApprove(policy, s.role))
          this.enqueue(
            s.id,
            { level: 'info', text: `proposal ${p.id} pending review: ${p.note ?? p.kind}` },
            'proposal',
          )
  }
}
