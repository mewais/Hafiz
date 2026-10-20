// Shared in-memory model: the memory backend keeps it in RAM; the fs backend persists it to files.
import { ConflictError } from '../domain/errors.js'
import type {
  AuditEntry,
  Block,
  BlockId,
  Doc,
  DocType,
  Edge,
  Project,
  Proposal,
  Session,
  SessionId,
  Thread,
} from '../domain/types.js'
import type {
  HistoryEntry,
  LogEntryOf,
  LogName,
  ReadOps,
  Sequenced,
  StorageBackend,
  TxMeta,
  WriteOps,
} from './backend.js'

export interface State {
  project: Project | null
  blocks: Map<BlockId, Block>
  docs: Map<string, Doc> // `${block}/${type}`
  docHistory: Map<
    string,
    Array<{ commit: string; doc: Doc; ts: string; author: string; message: string }>
  >
  logs: Map<string, Sequenced<unknown>[]> // `${block}/${log}`
  edges: Edge[]
  threads: Map<string, Thread & { seq: number }>
  sessions: Map<SessionId, Session>
  proposals: Map<string, Proposal>
  audit: AuditEntry[]
  seq: number
  commits: number
}

export const edgeKey = (e: Edge) => `${e.from}→${e.to}:${e.kind}`
export const clone = <T>(v: T): T => structuredClone(v)

export class Ops implements WriteOps {
  constructor(
    readonly s: State,
    private readonly meta?: TxMeta,
    private readonly commitId?: string,
  ) {}

  async getProject() {
    return this.s.project ? clone(this.s.project) : null
  }
  async getBlock(id: BlockId) {
    const b = this.s.blocks.get(id)
    return b ? clone(b) : null
  }
  async listBlocks() {
    return [...this.s.blocks.values()].map(clone)
  }
  async getDoc(block: BlockId, type: DocType) {
    const d = this.s.docs.get(`${block}/${type}`)
    return d ? clone(d) : null
  }
  async readLog<L extends LogName>(
    block: BlockId,
    log: L,
    opts: { last?: number; sinceSeq?: number } = {},
  ) {
    let rows = (this.s.logs.get(`${block}/${log}`) ?? []) as Sequenced<LogEntryOf[L]>[]
    if (opts.sinceSeq !== undefined) rows = rows.filter((r) => r.seq > (opts.sinceSeq as number))
    if (opts.last !== undefined) rows = rows.slice(-opts.last)
    return rows.map(clone)
  }
  async readSince(sinceSeq: number, limit = 200) {
    const out: Array<Sequenced<unknown> & { log: LogName | 'threads'; block: BlockId }> = []
    for (const [key, rows] of this.s.logs) {
      const [block, log] = key.split('/') as [BlockId, LogName]
      for (const r of rows) if (r.seq > sinceSeq) out.push({ ...clone(r), log, block })
    }
    for (const t of this.s.threads.values())
      if (t.seq > sinceSeq)
        out.push({ seq: t.seq, entry: clone(t), log: 'threads', block: t.blockId })
    return out.sort((a, b) => a.seq - b.seq).slice(0, limit)
  }
  async listEdges() {
    return clone(this.s.edges)
  }
  async getThread(id: string) {
    const t = this.s.threads.get(id)
    return t ? clone(t) : null
  }
  async listThreads(block?: BlockId) {
    return [...this.s.threads.values()].filter((t) => !block || t.blockId === block).map(clone)
  }
  async getSession(id: SessionId) {
    const x = this.s.sessions.get(id)
    return x ? clone(x) : null
  }
  async getSessionByToken(token: string) {
    for (const x of this.s.sessions.values()) if (x.token === token) return clone(x)
    return null
  }
  async listSessions(opts: { active?: boolean } = {}) {
    return [...this.s.sessions.values()]
      .filter((x) => opts.active === undefined || !x.endedAt === opts.active)
      .map(clone)
  }
  async listProposals(opts: { status?: Proposal['status'] } = {}) {
    return [...this.s.proposals.values()]
      .filter((p) => !opts.status || p.status === opts.status)
      .map(clone)
  }
  async readAudit(opts: { last?: number } = {}) {
    const a = opts.last ? this.s.audit.slice(-opts.last) : this.s.audit
    return clone(a)
  }
  async history(block: BlockId, type?: DocType): Promise<HistoryEntry[]> {
    const out: HistoryEntry[] = []
    for (const [key, h] of this.s.docHistory) {
      if (!key.startsWith(`${block}/`)) continue
      if (type && key !== `${block}/${type}`) continue
      for (const e of h)
        out.push({ commit: e.commit, ts: e.ts, author: e.author, message: e.message })
    }
    return out.sort((a, b) => (a.ts < b.ts ? 1 : -1))
  }
  async docAt(block: BlockId, type: DocType, commit: string) {
    const e = this.s.docHistory.get(`${block}/${type}`)?.find((x) => x.commit === commit)
    return e ? clone(e.doc) : null
  }
  async currentSeq() {
    return this.s.seq
  }

  // writes
  async putProject(p: Project) {
    this.s.project = clone(p)
  }
  async putBlock(b: Block, expectedVersion: number) {
    const cur = this.s.blocks.get(b.id)
    const actual = cur ? cur.version : -1
    if (actual !== expectedVersion)
      throw new ConflictError(`block ${b.id}`, expectedVersion, actual, cur ?? null)
    this.s.blocks.set(b.id, clone(b))
  }
  async putDoc(d: Doc, expectedVersion: number) {
    const key = `${d.blockId}/${d.type}`
    const cur = this.s.docs.get(key)
    const actual = cur ? cur.version : 0
    if (actual !== expectedVersion)
      throw new ConflictError(`${d.type} of ${d.blockId}`, expectedVersion, actual, cur ?? null)
    this.s.docs.set(key, clone(d))
    const h = this.s.docHistory.get(key) ?? []
    h.unshift({
      commit: this.commitId ?? `mem${++this.s.commits}`,
      doc: clone(d),
      ts: d.updatedAt,
      author: `${this.meta?.by.role ?? d.by.role}/${this.meta?.by.agent ?? d.by.agent ?? d.by.sessionId}`,
      message: this.meta?.message ?? this.meta?.command ?? 'write',
    })
    this.s.docHistory.set(key, h)
  }
  async appendLog<L extends LogName>(block: BlockId, log: L, entry: LogEntryOf[L]) {
    const key = `${block}/${log}`
    const rows = this.s.logs.get(key) ?? []
    const seq = ++this.s.seq
    rows.push({ seq, entry: clone(entry) })
    this.s.logs.set(key, rows)
    return seq
  }
  async putEdge(e: Edge) {
    if (!this.s.edges.some((x) => edgeKey(x) === edgeKey(e))) this.s.edges.push(clone(e))
  }
  async deleteEdge(e: Edge) {
    this.s.edges = this.s.edges.filter((x) => edgeKey(x) !== edgeKey(e))
  }
  async putThread(t: Thread) {
    const seq = ++this.s.seq
    this.s.threads.set(t.id, { ...clone(t), seq })
    return seq
  }
  async putSession(x: Session) {
    this.s.sessions.set(x.id, clone(x))
  }
  async putProposal(p: Proposal) {
    this.s.proposals.set(p.id, clone(p))
  }
  async appendAudit(a: AuditEntry) {
    this.s.audit.push(clone(a))
  }
}

export function emptyState(): State {
  return {
    project: null,
    blocks: new Map(),
    docs: new Map(),
    docHistory: new Map(),
    logs: new Map(),
    edges: [],
    threads: new Map(),
    sessions: new Map(),
    proposals: new Map(),
    audit: [],
    seq: 0,
    commits: 0,
  }
}

export function cloneState(s: State): State {
  return {
    project: clone(s.project),
    blocks: new Map(clone([...s.blocks])),
    docs: new Map(clone([...s.docs])),
    docHistory: new Map(clone([...s.docHistory])),
    logs: new Map(clone([...s.logs])),
    edges: clone(s.edges),
    threads: new Map(clone([...s.threads])),
    sessions: new Map(clone([...s.sessions])),
    proposals: new Map(clone([...s.proposals])),
    audit: clone(s.audit),
    seq: s.seq,
    commits: s.commits,
  }
}
