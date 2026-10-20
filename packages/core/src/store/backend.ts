// Storage SPI. Every backend passes the conformance suite in test/conformance.
import type {
  Actor,
  AuditEntry,
  Block,
  BlockId,
  Decision,
  Doc,
  DocType,
  Edge,
  ProgressEntry,
  Project,
  Proposal,
  Session,
  SessionId,
  StepEvent,
  Thread,
} from '../domain/types.js'

export type LogName = 'progress' | 'steps' | 'decisions'
export interface LogEntryOf {
  progress: ProgressEntry
  steps: StepEvent
  decisions: Decision
}

/** Every appended record and every thread write receives a project-wide sequence number. */
export interface Sequenced<T> {
  seq: number
  entry: T
}

export interface HistoryEntry {
  commit: string
  ts: string
  author: string
  message: string
}

export interface ReadOps {
  getProject(): Promise<Project | null>
  getBlock(id: BlockId): Promise<Block | null>
  listBlocks(): Promise<Block[]>
  getDoc(block: BlockId, type: DocType): Promise<Doc | null>
  readLog<L extends LogName>(
    block: BlockId,
    log: L,
    opts?: { last?: number; sinceSeq?: number },
  ): Promise<Sequenced<LogEntryOf[L]>[]>
  /** All records across blocks and logs with seq > sinceSeq, ascending. Used by the delta channel. */
  readSince(
    sinceSeq: number,
    limit?: number,
  ): Promise<Array<Sequenced<unknown> & { log: LogName | 'threads'; block: BlockId }>>
  listEdges(): Promise<Edge[]>
  getThread(id: string): Promise<Thread | null>
  listThreads(block?: BlockId): Promise<Thread[]>
  getSession(id: SessionId): Promise<Session | null>
  getSessionByToken(token: string): Promise<Session | null>
  listSessions(opts?: { active?: boolean }): Promise<Session[]>
  listProposals(opts?: { status?: Proposal['status'] }): Promise<Proposal[]>
  readAudit(opts?: { last?: number }): Promise<AuditEntry[]>
  history(block: BlockId, type?: DocType): Promise<HistoryEntry[]>
  /** Raw document content at a commit, for revert/diff. */
  docAt(block: BlockId, type: DocType, commit: string): Promise<Doc | null>
  currentSeq(): Promise<number>
}

export interface WriteOps extends ReadOps {
  putProject(p: Project): Promise<void>
  /** expectedVersion -1 = create (must not exist). Throws ConflictError on mismatch. */
  putBlock(b: Block, expectedVersion: number): Promise<void>
  putDoc(d: Doc, expectedVersion: number): Promise<void>
  appendLog<L extends LogName>(block: BlockId, log: L, entry: LogEntryOf[L]): Promise<number>
  putEdge(e: Edge): Promise<void>
  deleteEdge(e: Edge): Promise<void>
  putThread(t: Thread): Promise<number>
  putSession(s: Session): Promise<void>
  putProposal(p: Proposal): Promise<void>
  appendAudit(a: AuditEntry): Promise<void>
}

export interface TxMeta {
  by: Actor
  command: string
  /** Major writes bump the epoch and are committed individually; minor writes are batched. */
  major: boolean
  message?: string
}

export interface StorageBackend {
  readonly name: string
  open(): Promise<void>
  close(): Promise<void>
  /** Read outside a transaction (consistent snapshot not required). */
  readonly read: ReadOps
  /**
   * Atomic unit: all writes are applied or none. The backend persists the journal before
   * applying and recovers on open. Returns the commit id when the backend records history.
   */
  tx<T>(meta: TxMeta, fn: (t: WriteOps) => Promise<T>): Promise<{ result: T; commit?: string }>
  /** Hand edits or external changes since the last command, if the backend can tell. */
  dirty(): Promise<string[]>
}
