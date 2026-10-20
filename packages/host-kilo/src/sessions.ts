// Kilo session ↔ Hafiz session. The Kilo session id is used as the Hafiz session id; the role
// comes from the agent name, the parent from `parentID`, the spawned block from a
// `hafiz:block=<id>` marker in the task prompt. One daemon connection serves every session; each
// call carries that session's token explicitly.
import {
  type Config,
  estimatorTokenizer,
  type ResolvedProject,
  type Session,
  type Tokenizer,
} from '@hafiz/core'
import type { DaemonClient } from '@hafiz/gateway-mcp'
import type { SessionSource } from './shaper/core.js'

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
}

export interface RegistryOptions {
  project: ResolvedProject
  config: Config
  connect: () => Promise<DaemonClient>
  log: (line: string) => void
  tokenizer?: Tokenizer
}

export class SessionRegistry implements SessionSource {
  private readonly known = new Map<string, Known>()
  private client: Promise<DaemonClient> | undefined
  private closed = false
  private readonly tok: Tokenizer
  private readonly roles: Set<string>

  constructor(private readonly opts: RegistryOptions) {
    this.tok = opts.tokenizer ?? estimatorTokenizer
    this.roles = new Set(Object.keys(opts.config.roles.roles).filter((r) => r !== 'user'))
  }

  /** Hafiz role for a Kilo agent name, or undefined when the agent is not managed. */
  roleFor(agent: string | undefined): string | undefined {
    if (agent && this.roles.has(agent)) return agent
    return this.opts.config.hafiz.host.kilo.default_role
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
    if (hints.agent && !k.agent) k.agent = hints.agent
    if (k.token && !k.ended) return Promise.resolve(true)
    if (k.opening) return k.opening
    const role = this.roleFor(k.agent)
    if (!role) return Promise.resolve(false)
    const block = k.block ?? (hints.prompt ? blockFromPrompt(hints.prompt) : undefined)
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
        })
        Object.assign(k, { role, token: s.token, focus: s.focus.blocks, ended: false })
        if (block) k.block = block
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

  private async call<T>(id: string, method: string, params: Record<string, unknown> = {}) {
    const k = this.known.get(id)
    if (!k?.token) throw new Error(`session ${id} is not open`)
    return (await this.daemon()).call<T>(method, { token: k.token, ...params })
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
    return { envelope: v.text, floor: v.floorText }
  }

  async delta(id: string): Promise<string> {
    return (await this.call<{ text: string }>(id, 'context.delta')).text
  }

  async unfiled(id: string): Promise<string | undefined> {
    const s = await this.call<{ unfiledSummary?: string }>(id, 'session.self')
    return s.unfiledSummary
  }

  async close(): Promise<void> {
    this.closed = true
    const c = this.client
    this.client = undefined
    if (c) (await c.catch(() => undefined))?.close()
  }
}
