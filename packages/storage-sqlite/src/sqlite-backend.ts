// Single-file SQLite backend on `node:sqlite` (no native dependency). See docs/ARCHITECTURE.md §9.
//
// Model (same as the fs backend): the store is held in memory as a State shared with the memory
// backend; a transaction works on a deep copy and, on success, the difference is written inside
// one SQLite transaction (all or nothing) before the copy is swapped in. History lives in the
// `versions` table: one row per doc write, so `history` and `docAt` do not need git.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AuditEntry,
  Block,
  Doc,
  Edge,
  Project,
  Proposal,
  ReadOps,
  Session,
  StorageBackend,
  Thread,
  TxMeta,
  WriteOps,
} from '@hafiz/core'
import { cloneState, emptyState, Ops, type State } from '@hafiz/core/state'

export interface SqliteBackendOptions {
  /** Path of the database file (created with its parent directory). `:memory:` for tests. */
  file: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rows (key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS logs (
  block TEXT NOT NULL, log TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (block, log, seq)
);
CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL,
  commit_id TEXT NOT NULL, ts TEXT NOT NULL, author TEXT NOT NULL, message TEXT NOT NULL,
  doc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_doc ON versions (block, type, id);
`

/** Load `node:sqlite` without the experimental-feature warning on stderr. */
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning
  process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
    if (String(w).includes('SQLite')) return
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest)
  }) as typeof process.emitWarning
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

export class SqliteBackend implements StorageBackend {
  readonly name = 'sqlite'
  private state: State = emptyState()
  private db: DatabaseSync | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private rows = new Map<string, string>()
  private logCounts = new Map<string, number>()
  private versionCounts = new Map<string, number>()
  private auditCount = 0

  constructor(private readonly opts: SqliteBackendOptions) {}

  get file() {
    return this.opts.file
  }

  get read(): ReadOps {
    return new Ops(this.state)
  }

  async open(): Promise<void> {
    if (this.db) return
    if (this.opts.file !== ':memory:') mkdirSync(dirname(this.opts.file), { recursive: true })
    const { DatabaseSync } = loadSqlite()
    const db = new DatabaseSync(this.opts.file)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    db.exec(SCHEMA)
    this.db = db
    this.load(db)
  }

  async close(): Promise<void> {
    await this.queue
    this.db?.close()
    this.db = null
  }

  async dirty(): Promise<string[]> {
    return []
  }

  tx<T>(meta: TxMeta, fn: (t: WriteOps) => Promise<T>): Promise<{ result: T; commit?: string }> {
    const run = async () => {
      const db = this.must()
      const working = cloneState(this.state)
      const commit = `sql${working.commits + 1}`
      const result = await fn(new Ops(working, meta, commit))
      working.commits++
      this.persist(db, working)
      this.state = working
      return { result, commit }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  private must(): DatabaseSync {
    if (!this.db) throw new Error('sqlite backend is not open')
    return this.db
  }

  // ───────────── persistence ─────────────

  private persist(db: DatabaseSync, s: State) {
    const next = serialize(s)
    const put = db.prepare('INSERT OR REPLACE INTO rows (key, json) VALUES (?, ?)')
    const del = db.prepare('DELETE FROM rows WHERE key = ?')
    const insLog = db.prepare('INSERT INTO logs (block, log, seq, json) VALUES (?, ?, ?, ?)')
    const insAudit = db.prepare('INSERT INTO audit (n, json) VALUES (?, ?)')
    const insVersion = db.prepare(
      'INSERT INTO versions (block, type, version, commit_id, ts, author, message, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const logCounts = new Map(this.logCounts)
    const versionCounts = new Map(this.versionCounts)

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const [k, v] of next) if (this.rows.get(k) !== v) put.run(k, v)
      for (const k of this.rows.keys()) if (!next.has(k)) del.run(k)
      for (const [key, rows] of s.logs) {
        const [block, log] = key.split('/') as [string, string]
        for (let i = logCounts.get(key) ?? 0; i < rows.length; i++) {
          const r = rows[i] as { seq: number }
          insLog.run(block, log, r.seq, JSON.stringify(rows[i]))
        }
        logCounts.set(key, rows.length)
      }
      for (let i = this.auditCount; i < s.audit.length; i++)
        insAudit.run(i, JSON.stringify(s.audit[i]))
      for (const [key, h] of s.docHistory) {
        const fresh = h.length - (versionCounts.get(key) ?? 0)
        const [block, type] = key.split('/') as [string, string]
        for (const e of h.slice(0, fresh).reverse())
          insVersion.run(
            block,
            type,
            e.doc.version,
            e.commit,
            e.ts,
            e.author,
            e.message,
            JSON.stringify(e.doc),
          )
        versionCounts.set(key, h.length)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    this.rows = next
    this.logCounts = logCounts
    this.versionCounts = versionCounts
    this.auditCount = s.audit.length
  }

  private load(db: DatabaseSync) {
    const s = emptyState()
    const json = <T>(v: unknown) => JSON.parse(v as string) as T
    for (const r of db.prepare('SELECT key, json FROM rows').all()) {
      const key = r.key as string
      const text = r.json as string
      this.rows.set(key, text)
      const slash = key.indexOf('/')
      const kind = slash < 0 ? key : key.slice(0, slash)
      const rest = key.slice(slash + 1)
      if (key === 'project') s.project = json<Project>(text)
      else if (key === 'edges') s.edges = json<Edge[]>(text)
      else if (key === 'counters') Object.assign(s, json<{ seq: number; commits: number }>(text))
      else if (kind === 'block') s.blocks.set(rest, json<Block>(text))
      else if (kind === 'doc') s.docs.set(rest, json<Doc>(text))
      else if (kind === 'thread') s.threads.set(rest, json<Thread & { seq: number }>(text))
      else if (kind === 'session') s.sessions.set(rest, json<Session>(text))
      else if (kind === 'proposal') s.proposals.set(rest, json<Proposal>(text))
    }
    for (const r of db.prepare('SELECT block, log, json FROM logs ORDER BY seq').all()) {
      const key = `${r.block}/${r.log}`
      const rows = s.logs.get(key) ?? []
      rows.push(json(r.json))
      s.logs.set(key, rows)
      this.logCounts.set(key, rows.length)
    }
    for (const r of db.prepare('SELECT json FROM audit ORDER BY n').all())
      s.audit.push(json<AuditEntry>(r.json))
    this.auditCount = s.audit.length
    for (const r of db
      .prepare(
        'SELECT block, type, commit_id, ts, author, message, doc FROM versions ORDER BY id DESC',
      )
      .all()) {
      const key = `${r.block}/${r.type}`
      const h = s.docHistory.get(key) ?? []
      h.push({
        commit: r.commit_id as string,
        ts: r.ts as string,
        author: r.author as string,
        message: r.message as string,
        doc: json<Doc>(r.doc),
      })
      s.docHistory.set(key, h)
      this.versionCounts.set(key, h.length)
    }
    this.state = s
  }
}

function serialize(s: State): Map<string, string> {
  const f = new Map<string, string>()
  if (s.project) f.set('project', JSON.stringify(s.project))
  f.set('edges', JSON.stringify(s.edges))
  f.set('counters', JSON.stringify({ seq: s.seq, commits: s.commits }))
  for (const b of s.blocks.values()) f.set(`block/${b.id}`, JSON.stringify(b))
  for (const [key, d] of s.docs) f.set(`doc/${key}`, JSON.stringify(d))
  for (const t of s.threads.values()) f.set(`thread/${t.id}`, JSON.stringify(t))
  for (const x of s.sessions.values()) f.set(`session/${x.id}`, JSON.stringify(x))
  for (const p of s.proposals.values()) f.set(`proposal/${p.id}`, JSON.stringify(p))
  return f
}
