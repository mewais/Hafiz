// The daemon's brain: maps (method, token) onto Core, keeps per-session notice queues and keeps
// computed focus fresh. All requests run one at a time: Core reads sessions outside transactions,
// so serialising here removes read-modify-write races between clients.
import {
  type Actor,
  authorize,
  type ContextOptions,
  type Core,
  focusFromPolicy,
  isAllowed,
  type Notice,
  type Session,
  ValidationError,
} from '@hafiz/core'
import { z } from 'zod'
import { RPC_CODES, RpcFailure } from './rpc.js'

export interface QueuedNotice extends Notice {
  /** What produced it: `nudge`, `proposal`, … */
  event: string
  ts: string
}

const QUEUE_CAP = 50

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
  'project.status': z.object(token),
  'session.end': z.object(token),
  'counters.add': z.object({ ...token, delta: z.record(z.string(), z.number()) }),
  'proposal.list': z.object({
    ...token,
    status: z.enum(['pending', 'accepted', 'rejected']).optional(),
  }),
  'notices.drain': z.object(token),
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
  private readonly nudged = new Map<string, number>()
  /** Proposals already announced (everything pending at startup counts as old news). */
  private seenProposals = new Set<string>()

  constructor(readonly core: Core) {}

  async init(): Promise<void> {
    for (const p of await this.core.backend.read.listProposals()) this.seenProposals.add(p.id)
  }

  /** Entry point for one RPC call; errors surface as RpcFailure/HafizError for the caller to map. */
  handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const run = this.chain.then(() => this.exec(method, params))
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Resolves once everything accepted so far has finished. */
  idle(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  private async exec(method: string, raw: Record<string, unknown>): Promise<unknown> {
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
    const by: Actor = {
      sessionId: session.id,
      role: session.role,
      ...(session.agent ? { agent: session.agent } : {}),
    }
    const core = this.core
    switch (method as DaemonMethod) {
      case 'dispatch': {
        const command = p.command as string
        const out = await core.dispatch(by, command, p.args as Record<string, unknown>)
        if (command.startsWith('block.') || command.startsWith('proposal.'))
          await this.afterStatusWrite(by.sessionId)
        return out
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
          sessions: (await r.listSessions()).map(publicSession),
          pendingProposals: (await r.listProposals({ status: 'pending' })).length,
        }
      }
      case 'session.end':
        await core.sessionEnd(session.id)
        this.queues.delete(session.id)
        return { ended: true }
      case 'counters.add': {
        const s = await core.countersAdd(session.id, p.delta as Record<string, number>)
        if (s) await this.maybeNudge(s)
        return s ? publicSession(s) : null
      }
      case 'proposal.list': {
        authorize(core.config, by.role, 'proposal.list')
        const status = p.status as 'pending' | 'accepted' | 'rejected' | undefined
        return core.backend.read.listProposals(status ? { status } : undefined)
      }
      case 'notices.drain': {
        const q = this.queues.get(session.id) ?? []
        this.queues.delete(session.id)
        return q
      }
      default:
        throw new RpcFailure({ code: RPC_CODES.method_not_found, message: 'unknown method' })
    }
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
    for (const s of await this.core.backend.read.listSessions({ active: true }))
      await this.refreshIfStale(s)
    await this.announceNewProposals(caller)
  }

  // ───────────────────────── notices ─────────────────────────

  enqueue(sessionId: string, n: Notice, event: string): void {
    const q = this.queues.get(sessionId) ?? []
    q.push({ ...n, event, ts: this.core.clock.now() })
    while (q.length > QUEUE_CAP) q.shift()
    this.queues.set(sessionId, q)
  }

  /** Tell sessions that can review proposals when a new one lands. */
  private async announceNewProposals(caller: string): Promise<void> {
    const r = this.core.backend.read
    const seen = this.seenProposals
    const fresh = (await r.listProposals({ status: 'pending' })).filter((p) => !seen.has(p.id))
    if (!fresh.length) return
    for (const p of fresh) seen.add(p.id)
    for (const s of await r.listSessions({ active: true })) {
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
    const cfg = this.core.config.nudge
    if ((this.nudged.get(s.id) ?? 0) >= cfg.max_per_session) return
    const over = Object.entries(cfg.thresholds).some(([k, t]) => (s.counters[k] ?? 0) >= t)
    if (!over || (await this.core.treeListRaw()).length > 1) return
    this.nudged.set(s.id, (this.nudged.get(s.id) ?? 0) + 1)
    const text = cfg.template.replace(/\{(\w+)\}/g, (_, k: string) => String(s.counters[k] ?? 0))
    this.enqueue(s.id, { level: 'info', text }, 'nudge')
  }
}
