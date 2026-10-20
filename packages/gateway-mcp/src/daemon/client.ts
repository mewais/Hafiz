// Typed client for the daemon socket, plus `ensureDaemon` (connect, or spawn and wait).
import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import type {
  CommandResult,
  ContextView,
  DeltaResult,
  Explanation,
  HistoryEntry,
  Proposal,
  ResolvedProject,
  Session,
  TreeSummary,
} from '@hafiz/core'
import { socketPathFor } from './paths.js'
import { RpcError, type RpcRequest, type RpcResponse, toRpcError } from './rpc.js'
import type { QueuedNotice } from './service.js'

export type SessionRecord = Session

export interface SessionOpenParams {
  id: string
  host: string
  role: string
  agent?: string
  parentSessionId?: string
  spawnedBlock?: string
}

export interface SessionStatus {
  session: Omit<Session, 'token'>
  epoch: number
  pendingNotices: number
}

export interface ProjectStatus {
  project: { id: string; name: string; epoch: number; rootBlockId: string } | null
  sessions: Array<Omit<Session, 'token'>>
  pendingProposals: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Answers requests the daemon sends this client (`llm.complete` for a registered relay). */
export type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

export class DaemonClient {
  /** Capability token; set by `openSession` or directly (adapter-minted). */
  token: string | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private buf = ''
  /** Set by `serveLlm`; answers the daemon's own requests on this connection. */
  private onRequest: RequestHandler | undefined
  private closeHandlers: Array<() => void> = []

  private constructor(private readonly sock: Socket) {
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => this.onData(chunk))
    const fail = (e?: Error) => {
      for (const p of this.pending.values()) p.reject(e ?? new Error('daemon connection closed'))
      this.pending.clear()
    }
    sock.on('close', () => {
      fail()
      for (const h of this.closeHandlers.splice(0)) h()
    })
    sock.on('error', (e) => fail(e))
  }

  /** Called once when the connection closes (daemon exit, idle shutdown, `close()`). */
  onClose(h: () => void): void {
    this.closeHandlers.push(h)
  }

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const sock = createConnection(socketPath)
      sock.once('connect', () => {
        sock.off('error', reject)
        resolve(new DaemonClient(sock))
      })
      sock.once('error', reject)
    })
  }

  private onData(chunk: string) {
    this.buf += chunk
    let i = this.buf.indexOf('\n')
    while (i >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (line) this.onLine(line)
      i = this.buf.indexOf('\n')
    }
  }

  private onLine(line: string) {
    const msg = JSON.parse(line) as RpcResponse | RpcRequest
    if ('method' in msg) return void this.answer(msg)
    const res = msg
    const p = typeof res.id === 'number' ? this.pending.get(res.id) : undefined
    if (!p) return
    this.pending.delete(res.id as number)
    if (res.error) p.reject(new RpcError(res.error.code, res.error.message, res.error.data))
    else p.resolve(res.result)
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const withToken =
      this.token && method !== 'session.open' ? { token: this.token, ...params } : params
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: withToken })}\n`)
    })
  }

  private async answer(req: RpcRequest) {
    const reply = (r: Omit<RpcResponse, 'jsonrpc' | 'id'>) => {
      if (!this.sock.destroyed)
        this.sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, ...r })}\n`)
    }
    if (!this.onRequest)
      return reply({ error: { code: -32601, message: `client does not serve '${req.method}'` } })
    try {
      reply({ result: (await this.onRequest(req.method, req.params ?? {})) ?? null })
    } catch (e) {
      reply({ error: toRpcError(e) })
    }
  }

  close(): void {
    this.sock.end()
    this.sock.destroy()
  }

  // ───────────────────────── typed calls ─────────────────────────

  /** Open or re-attach a session and adopt its token for later calls. */
  async openSession(p: SessionOpenParams): Promise<SessionRecord> {
    const s = await this.call<SessionRecord>('session.open', { ...p })
    this.token = s.token
    return s
  }
  dispatch<T = unknown>(command: string, args: Record<string, unknown> = {}) {
    return this.call<CommandResult<T>>('dispatch', { command, args })
  }
  contextFor(o: { model?: string; budgetTokens?: number } = {}) {
    return this.call<ContextView>('context.for', o)
  }
  contextExplain(block: string, o: { model?: string; budgetTokens?: number } = {}) {
    return this.call<Explanation>('context.explain', { block, ...o })
  }
  contextDelta() {
    return this.call<DeltaResult>('context.delta')
  }
  blockRead(id: string, zoom?: string) {
    return this.call<string>('block.read', zoom ? { id, zoom } : { id })
  }
  treeList() {
    return this.call<
      Array<{
        id: string
        parentId: string | null
        title: string
        kind: string
        status: string
        order: number
        depth: number
      }>
    >('tree.list')
  }
  sessionStatus() {
    return this.call<SessionStatus>('session.status')
  }
  /** This session's own record; unlike session.status, open to every role. */
  sessionSelf() {
    return this.call<Omit<Session, 'token'>>('session.self')
  }
  projectStatus() {
    return this.call<ProjectStatus>('project.status')
  }
  sessionEnd() {
    return this.call<{ ended: true }>('session.end')
  }
  countersAdd(delta: Record<string, number>) {
    return this.call<Omit<Session, 'token'> | null>('counters.add', { delta })
  }
  proposalList(status?: Proposal['status']) {
    return this.call<Proposal[]>('proposal.list', status ? { status } : {})
  }
  noticesDrain() {
    return this.call<QueuedNotice[]>('notices.drain')
  }
  /** Recent notices of a session (default: this one) without draining them. */
  noticesPeek(session?: string) {
    return this.call<QueuedNotice[]>('notices.peek', session ? { session } : {})
  }
  treeSummary(o: { recentDecisions?: number } = {}) {
    return this.call<TreeSummary>('tree.summary', { ...o })
  }
  blockHistory(id: string, type?: 'design' | 'plan' | 'digest') {
    return this.call<HistoryEntry[]>('block.history', type ? { id, type } : { id })
  }
  /**
   * Offer to run relayed LLM providers for the daemon (the Kilo plugin runs `kilo`). The daemon
   * then sends `llm.complete {provider, settings, request}` over this connection; `handler`
   * answers with an LLMResult. Calls carry `token` (any open session of this connection).
   */
  async serveLlm(
    providers: string[],
    handler: RequestHandler,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    this.onRequest = handler
    await this.call('llm.serve', { ...params, providers })
  }
}

export interface EnsureDaemonOptions {
  env?: NodeJS.ProcessEnv
  /** Path of the `hafiz` entry script (bin.js) used to spawn `hafiz daemon`. */
  entry?: string
  /** Replace the spawn step (tests). */
  spawnDaemon?: (project: ResolvedProject) => void
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Connect to the project's daemon, starting a detached one if none answers. */
export async function ensureDaemon(
  project: ResolvedProject,
  opts: EnsureDaemonOptions = {},
): Promise<DaemonClient> {
  const env = opts.env ?? process.env
  const sock = socketPathFor(project.pointer.id, env)
  try {
    return await DaemonClient.connect(sock)
  } catch {}
  if (opts.spawnDaemon) opts.spawnDaemon(project)
  else {
    const entry = opts.entry ?? env.HAFIZ_BIN
    if (!entry)
      throw new Error('cannot start the daemon: no hafiz entry script known (set HAFIZ_BIN)')
    spawn(process.execPath, [entry, 'daemon', '--project', project.repoRoot], {
      detached: true,
      stdio: 'ignore',
      env,
    }).unref()
  }
  const deadline = Date.now() + (opts.timeoutMs ?? 15000)
  let last: unknown
  while (Date.now() < deadline) {
    await sleep(50)
    try {
      return await DaemonClient.connect(sock)
    } catch (e) {
      last = e
    }
  }
  throw new Error(`daemon for ${project.pointer.id} did not come up at ${sock}: ${String(last)}`)
}
