// Kilo session ↔ Hafiz session. The Kilo session id is used as the Hafiz session id; the role
// comes from the agent name, the parent from `parentID`, the spawned block from a
// `hafiz:block=<id>` marker in the task prompt. One daemon connection serves every session; each
// call carries that session's token explicitly.
import {
  agentRoleNames,
  type Config,
  estimatorTokenizer,
  type ResolvedProject,
  rulesFor,
  type Session,
  type Tokenizer,
} from '@hafiz/core'
import type { DaemonClient, RequestHandler } from '@hafiz/gateway-mcp'
import { CONDENSER_AGENT } from './llm.js'
import type { CondenseRequest, SessionSource, UnfiledState } from './shaper/core.js'

/** Convention: a task prompt containing `hafiz:block=<id>` spawns the subagent on that block. */
export const BLOCK_MARKER = /hafiz:block=([A-Za-z0-9_.-]+)/

export function blockFromPrompt(text: string): string | undefined {
  return BLOCK_MARKER.exec(text)?.[1]
}

/** Cap a report at `cap` tokens; the cut is marked with the number of tokens left out. */
export function capReport(text: string, cap: number, tok: Tokenizer = estimatorTokenizer): string {
  const total = tok.count(text)
  if (total <= cap) return text
  const marker = (n: number) => `\n[truncated, ${n} tokens]`
  let lo = 0
  let hi = text.length
  // longest prefix that fits together with its marker
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const head = text.slice(0, mid)
    if (tok.count(head + marker(total - tok.count(head))) <= cap) lo = mid
    else hi = mid - 1
  }
  const head = text.slice(0, lo).trimEnd()
  return head + marker(total - tok.count(head))
}

interface Known {
  parentId?: string
  agent?: string
  /** Set once opened with the daemon. */
  role?: string
  token?: string
  block?: string
  focus?: string[]
  ended?: boolean
  opening?: Promise<boolean> | undefined
  /** Fingerprints of reports already captured (dedupe tool.after vs idle fallback). */
  reports?: Set<string>
  /** Hafiz's own helper session (the `kilo` LLM provider's child): never managed. */
  ignored?: boolean
}

export interface RegistryOptions {
  project: ResolvedProject
  config: Config
  connect: () => Promise<DaemonClient>
  log: (line: string) => void
  tokenizer?: Tokenizer
  /** Relayed LLM providers this plugin runs for the daemon (`kilo`), and how. */
  llm?: { providers: string[]; handler: RequestHandler }
}

export class SessionRegistry implements SessionSource {
  private readonly known = new Map<string, Known>()
  private client: Promise<DaemonClient> | undefined
  private closed = false
  private serving: DaemonClient | undefined
  private readonly tok: Tokenizer
  private readonly roles: Set<string>

  constructor(private readonly opts: RegistryOptions) {
    this.tok = opts.tokenizer ?? estimatorTokenizer
    this.roles = new Set(agentRoleNames(opts.config))
  }

  /** True when the Kilo agent is one of Hafiz's own role agents (its prompt is the rules). */
  isRoleAgent(agent: string | undefined): boolean {
    return !!agent && this.roles.has(agent)
  }

  /**
   * Hafiz role for a Kilo session, or undefined when it is not managed. Role agents are their
   * role. Other primary agents (build, plan, custom) get `host.kilo.default_role`; other
   * subagents (general, explore, …) get `host.kilo.default_subagent_role`, but only when spawned
   * on a block (`hafiz:block=<id>` in the task prompt). `none` switches either off.
   */
  roleFor(
    agent: string | undefined,
    where: { subagent?: boolean; block?: string | undefined } = {},
  ): string | undefined {
    if (agent === CONDENSER_AGENT) return undefined
    if (agent && this.roles.has(agent)) return agent
    const kilo = this.opts.config.hafiz.host.kilo
    const r = where.subagent
      ? where.block
        ? kilo.default_subagent_role
        : undefined
      : kilo.default_role
    if (!r || r === 'none') return undefined
    if (!this.opts.config.roles.roles[r]) {
      this.opts.log(`hafiz: host.kilo default role '${r}' is not a configured role; ignoring`)
      return undefined
    }
    return r
  }

  private daemon(): Promise<DaemonClient> {
    if (this.closed) return Promise.reject(new Error('plugin disposed'))
    if (!this.client) {
      this.client = this.opts.connect()
      this.client.catch(() => {
        this.client = undefined
      })
    }
    return this.client
  }

  private entry(id: string): Known {
    let k = this.known.get(id)
    if (!k) {
      k = {}
      this.known.set(id, k)
    }
    return k
  }

  /** `session.created`: remember parent and agent; opening waits for the first message. */
  noteSession(info: { id: string; parentID?: string | undefined; agent?: string | undefined }) {
    const k = this.entry(info.id)
    if (info.parentID) k.parentId = info.parentID
    if (info.agent) k.agent = info.agent
  }

  /** Never manage this Kilo session (a child Hafiz created to run the `kilo` LLM provider). */
  ignore(id: string): void {
    this.entry(id).ignored = true
  }

  isIgnored(id: string): boolean {
    return !!this.known.get(id)?.ignored
  }

  get(id: string): Readonly<Known> | undefined {
    return this.known.get(id)
  }

  isManaged(id: string): boolean {
    const k = this.known.get(id)
    return !!k?.token && !k.ended
  }

  /** Open (or re-attach) the Hafiz session for a Kilo session. Resolves false if unmanaged. */
  open(id: string, hints: { agent?: string | undefined; prompt?: string | undefined } = {}) {
    const k = this.entry(id)
    if (k.ignored) return Promise.resolve(false)
    if (hints.agent && !k.agent) k.agent = hints.agent
    if (k.token && !k.ended) return Promise.resolve(true)
    if (k.opening) return k.opening
    const block = k.block ?? (hints.prompt ? blockFromPrompt(hints.prompt) : undefined)
    const role = this.roleFor(k.agent, { subagent: !!k.parentId, block })
    if (!role) return Promise.resolve(false)
    k.opening = (async () => {
      try {
        const c = await this.daemon()
        const parent = k.parentId && this.known.get(k.parentId)?.token ? k.parentId : undefined
        const s = await c.call<Session>('session.open', {
          id,
          host: 'kilo',
          role,
          ...(k.agent ? { agent: k.agent } : {}),
          ...(parent ? { parentSessionId: parent } : {}),
          ...(block ? { spawnedBlock: block } : {}),
          // this Kilo instance's working tree: worktrees share the daemon, not the checkout
          worktree: this.opts.project.worktree,
        })
        Object.assign(k, { role, token: s.token, focus: s.focus.blocks, ended: false })
        if (block) k.block = block
        await this.serveLlm(c, s.token)
        return true
      } catch (e) {
        this.opts.log(`hafiz: could not open session ${id} as ${role}: ${String(e)}`)
        return false
      } finally {
        delete k.opening
      }
    })()
    return k.opening
  }

  /** Offer the relayed LLM providers on this connection, once (needs any open session's token). */
  private async serveLlm(c: DaemonClient, token: string): Promise<void> {
    const llm = this.opts.llm
    if (!llm || this.serving === c) return
    this.serving = c
    try {
      await c.serveLlm(llm.providers, llm.handler, { token })
    } catch (e) {
      this.serving = undefined
      this.opts.log(`hafiz: cannot serve llm provider(s) ${llm.providers.join(', ')}: ${String(e)}`)
    }
  }

  /** One daemon call as session `id` (its token is attached). */
  async call<T>(id: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    const k = this.known.get(id)
    if (!k?.token) throw new Error(`session ${id} is not open`)
    const c = await this.daemon()
    if (this.opts.llm && this.serving !== c) await this.serveLlm(c, k.token) // after a reconnect
    return c.call<T>(method, { token: k.token, ...params })
  }

  async counters(id: string, delta: Record<string, number>): Promise<void> {
    if (!this.isManaged(id)) return
    await this.call(id, 'counters.add', { delta }).catch((e) => {
      if (!this.closed) this.opts.log(`hafiz: counters for ${id} failed: ${String(e)}`)
    })
  }

  async end(id: string): Promise<void> {
    const k = this.known.get(id)
    if (!k?.token || k.ended) return
    await this.call(id, 'session.end').catch(() => undefined)
    k.ended = true
  }

  /**
   * Store a subagent's final message as a `report` progress entry on its focus block, capped
   * at `compliance.yaml report_capture.cap_tokens`. Written as the child; if its role may not
   * append progress, as the parent. Duplicate texts for the same child are ignored.
   */
  async captureReport(childId: string, text: string): Promise<boolean> {
    const rc = this.opts.config.compliance.report_capture
    const k = this.known.get(childId)
    if (!rc.enabled || !k?.token || !text.trim()) return false
    const fp = `${text.length}:${text.slice(0, 64)}:${text.slice(-64)}`
    k.reports ??= new Set()
    if (k.reports.has(fp)) return false
    const block = k.block ?? k.focus?.[0]
    if (!block) {
      this.opts.log(`hafiz: report from ${childId} not captured: session has no focus block`)
      return false
    }
    k.reports.add(fp)
    const args = {
      command: 'progress.append',
      args: { block, kind: 'report', text: capReport(text, rc.cap_tokens, this.tok) },
    }
    for (const who of [childId, k.parentId]) {
      if (!who || !this.known.get(who)?.token) continue
      try {
        await this.call(who, 'dispatch', args)
        return true
      } catch (e) {
        this.opts.log(`hafiz: report capture as ${who} failed: ${String(e)}`)
      }
    }
    k.reports.delete(fp)
    return false
  }

  // ───────────────────────── SessionSource ─────────────────────────

  async view(id: string, model?: string) {
    const v = await this.call<{ text: string; floorText: string }>(
      id,
      'context.for',
      model ? { model } : {},
    )
    // Agents managed under a default role run Kilo's own prompt; give them the role's rules
    // ahead of the envelope (constant text, so the cached prefix stays stable).
    const k = this.known.get(id)
    const rules = k?.role && !this.isRoleAgent(k.agent) ? rulesFor(this.opts.config, k.role) : ''
    return { envelope: rules ? `${rules}\n\n${v.text}` : v.text, floor: v.floorText }
  }

  /**
   * The delta plus any notices queued for the session (compliance, nudge, proposals). They ride
   * in the tail so a session that never calls a Hafiz tool still hears them; the shaper's ledger
   * keeps them in place on later requests.
   */
  async delta(id: string): Promise<string> {
    const [d, queued] = await Promise.all([
      this.call<{ text: string }>(id, 'context.delta'),
      this.call<Array<{ event: string; text: string }>>(id, 'notices.drain').catch(() => []),
    ])
    if (!queued.length) return d.text
    const notes = queued.map((n) => `- [${n.event}] ${n.text}`).join('\n')
    return [d.text, `<hafiz-notices>\n${notes}\n</hafiz-notices>`].filter(Boolean).join('\n')
  }

  async unfiled(id: string): Promise<UnfiledState | undefined> {
    const s = await this.call<
      Pick<Session, 'unfiledSummary' | 'condensed' | 'checkpointRequested'>
    >(id, 'session.self')
    return {
      summary: s.unfiledSummary,
      cursor: s.condensed,
      checkpoint: s.checkpointRequested,
    }
  }

  condense(id: string, req: CondenseRequest): Promise<unknown> {
    return this.call(id, 'condense', { ...req })
  }

  async close(): Promise<void> {
    this.closed = true
    const c = this.client
    this.client = undefined
    if (c) (await c.catch(() => undefined))?.close()
  }
}
