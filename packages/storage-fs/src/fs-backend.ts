// Git-backed, journaled filesystem backend. See docs/ARCHITECTURE.md §9.
//
// Model: the whole store is held in memory as a State (shared with the memory backend). A
// transaction works on a deep copy; on success the new state is serialised to files, the changed
// files are staged in a write-ahead journal (fsynced), applied with temp+rename, then committed to
// git with the acting session as author. Recovery on open replays any journal left behind.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type {
  AuditEntry,
  Block,
  Doc,
  DocType,
  Edge,
  HistoryEntry,
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
import { type SimpleGit, simpleGit } from 'simple-git'
import { docToMarkdown, type FileMap, jsonl, markdownToDoc, paths, yaml } from './files.js'

export interface FsBackendOptions {
  dir: string
  git?: boolean
  /** Seconds to batch minor writes before committing; 0 = commit every transaction. */
  minorBatchSeconds?: number
}

const JOURNAL_DIR = '.journal'
const GITIGNORE = `${JOURNAL_DIR}/\n.lock\n`

export class FsBackend implements StorageBackend {
  readonly name = 'fs'
  private state: State = emptyState()
  private written: FileMap = new Map()
  private queue: Promise<unknown> = Promise.resolve()
  private git: SimpleGit | null = null
  private pendingMinor = false
  private minorTimer: NodeJS.Timeout | null = null
  private readonly useGit: boolean
  private readonly minorBatchMs: number

  constructor(private readonly opts: FsBackendOptions) {
    this.useGit = opts.git ?? true
    this.minorBatchMs = (opts.minorBatchSeconds ?? 30) * 1000
  }

  get dir() {
    return this.opts.dir
  }

  get read(): ReadOps {
    return new FsReadOps(this.state, this)
  }

  async open(): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    this.recoverJournal()
    this.written = readAll(this.dir)
    this.state = deserialize(this.written)
    if (this.useGit) {
      this.git = simpleGit(this.dir)
      if (!existsSync(join(this.dir, '.git'))) {
        await this.git.init()
        await this.git.addConfig('user.name', 'hafiz')
        await this.git.addConfig('user.email', 'hafiz@local')
        await this.git.addConfig('commit.gpgsign', 'false')
        writeFileSync(join(this.dir, '.gitignore'), GITIGNORE)
        await this.git.add('.gitignore')
        await this.git.commit('hafiz: initialise store')
      }
    }
  }

  async close(): Promise<void> {
    if (this.minorTimer) clearTimeout(this.minorTimer)
    this.minorTimer = null
    await this.flushMinor('hafiz: batched minor writes')
  }

  async dirty(): Promise<string[]> {
    if (!this.git || this.pendingMinor) return []
    const st = await this.git.status()
    return st.files.map((f) => f.path).filter((p) => !p.startsWith(JOURNAL_DIR))
  }

  tx<T>(meta: TxMeta, fn: (t: WriteOps) => Promise<T>): Promise<{ result: T; commit?: string }> {
    const run = async () => {
      const working = cloneState(this.state)
      const result = await fn(new Ops(working, meta))
      working.commits++
      const files = serialize(working)
      const { writes, deletes } = diff(this.written, files)
      if (writes.size || deletes.length) {
        this.journalAndApply(writes, deletes)
        this.written = files
      }
      this.state = working
      const commit = await this.commitFor(meta)
      return commit ? { result, commit } : { result }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  // ───────────── journal ─────────────

  private journalAndApply(writes: FileMap, deletes: string[]) {
    const jdir = join(this.dir, JOURNAL_DIR)
    mkdirSync(jdir, { recursive: true })
    const jpath = join(jdir, `${Date.now()}-${process.pid}.json`)
    const tmp = `${jpath}.tmp`
    writeFileSync(tmp, JSON.stringify({ writes: Object.fromEntries(writes), deletes }))
    const fd = openSync(tmp, 'r')
    fsyncSync(fd)
    closeSync(fd)
    renameSync(tmp, jpath)
    this.apply(writes, deletes)
    rmSync(jpath, { force: true })
  }

  private apply(writes: FileMap, deletes: string[]) {
    for (const [rel, content] of writes) {
      const abs = join(this.dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(`${abs}.tmp`, content)
      renameSync(`${abs}.tmp`, abs)
    }
    for (const rel of deletes) rmSync(join(this.dir, rel), { force: true })
  }

  private recoverJournal() {
    const jdir = join(this.dir, JOURNAL_DIR)
    if (!existsSync(jdir)) return
    for (const f of readdirSync(jdir).sort()) {
      const p = join(jdir, f)
      if (!f.endsWith('.json')) {
        rmSync(p, { force: true })
        continue
      }
      const j = JSON.parse(readFileSync(p, 'utf8')) as {
        writes: Record<string, string>
        deletes: string[]
      }
      this.apply(new Map(Object.entries(j.writes)), j.deletes)
      rmSync(p, { force: true })
    }
  }

  // ───────────── git ─────────────

  private author(by: TxMeta['by']) {
    return `${by.role}/${by.agent ?? by.sessionId} <${by.sessionId}@hafiz>`
  }

  private async commitFor(meta: TxMeta): Promise<string | undefined> {
    if (!this.git) return undefined
    if (!meta.major && this.minorBatchMs > 0) {
      this.pendingMinor = true
      if (!this.minorTimer)
        this.minorTimer = setTimeout(() => {
          this.minorTimer = null
          this.queue = this.queue.then(() => this.flushMinor('hafiz: batched minor writes'))
        }, this.minorBatchMs)
      this.minorTimer.unref?.()
      return undefined
    }
    return this.commitAll(meta.message ?? `${meta.command}`, this.author(meta.by))
  }

  private async flushMinor(message: string) {
    if (!this.git || !this.pendingMinor) return
    this.pendingMinor = false
    await this.commitAll(message, 'hafiz <hafiz@local>')
  }

  private async commitAll(message: string, author: string): Promise<string | undefined> {
    if (!this.git) return undefined
    await this.git.add('-A')
    const st = await this.git.status()
    if (!st.staged.length && !st.files.length) return undefined
    const r = await this.git.commit(message, undefined, { '--author': author })
    return r.commit || undefined
  }

  async gitHistory(path: string): Promise<HistoryEntry[]> {
    if (!this.git) return []
    try {
      const log = await this.git.log({
        file: path,
        format: { commit: '%H', ts: '%aI', author: '%an', message: '%s' },
      })
      return log.all.map((e) => ({
        commit: e.commit,
        ts: e.ts,
        author: e.author,
        message: e.message,
      }))
    } catch {
      return []
    }
  }

  async gitShow(commit: string, path: string): Promise<string | null> {
    if (!this.git) return null
    try {
      return await this.git.show([`${commit}:${path}`])
    } catch {
      return null
    }
  }
}

/** Reads come from memory; history/docAt go to git. */
class FsReadOps extends Ops {
  constructor(
    s: State,
    private readonly fs: FsBackend,
  ) {
    super(s)
  }
  override async history(block: string, type?: DocType): Promise<HistoryEntry[]> {
    const p = type ? paths.doc(block, type) : `blocks/${block}`
    return this.fs.gitHistory(p)
  }
  override async docAt(block: string, type: DocType, commit: string): Promise<Doc | null> {
    const text = await this.fs.gitShow(commit, paths.doc(block, type))
    return text ? markdownToDoc(text) : null
  }
}

// ───────────── (de)serialisation ─────────────

function serialize(s: State): FileMap {
  const f: FileMap = new Map()
  if (s.project) f.set(paths.project, yaml.stringify(s.project))
  f.set(paths.edges, yaml.stringify({ edges: s.edges }))
  f.set(paths.seq, JSON.stringify({ seq: s.seq, commits: s.commits }))
  f.set(paths.sessions, JSON.stringify([...s.sessions.values()], null, 2))
  f.set(paths.proposals, JSON.stringify([...s.proposals.values()], null, 2))
  f.set(paths.audit, jsonl.stringify(s.audit))
  for (const b of s.blocks.values()) f.set(paths.block(b.id), yaml.stringify(b))
  for (const [key, d] of s.docs) {
    const [block, type] = key.split('/') as [string, string]
    f.set(paths.doc(block, type), docToMarkdown(d))
  }
  for (const [key, rows] of s.logs) {
    const [block, log] = key.split('/') as [string, string]
    f.set(paths.log(block, log), jsonl.stringify(rows))
  }
  for (const t of s.threads.values()) f.set(paths.thread(t.blockId, t.id), yaml.stringify(t))
  return f
}

function deserialize(files: FileMap): State {
  const s = emptyState()
  const get = (p: string) => files.get(p)
  const proj = get(paths.project)
  if (proj) s.project = yaml.parse<Project>(proj)
  const edges = get(paths.edges)
  if (edges) s.edges = yaml.parse<{ edges: Edge[] }>(edges).edges ?? []
  const seq = get(paths.seq)
  if (seq) Object.assign(s, JSON.parse(seq) as { seq: number; commits: number })
  const sessions = get(paths.sessions)
  if (sessions) for (const x of JSON.parse(sessions) as Session[]) s.sessions.set(x.id, x)
  const proposals = get(paths.proposals)
  if (proposals) for (const x of JSON.parse(proposals) as Proposal[]) s.proposals.set(x.id, x)
  const audit = get(paths.audit)
  if (audit) s.audit = jsonl.parse<AuditEntry>(audit)
  for (const [p, content] of files) {
    const m = /^blocks\/([^/]+)\/(.+)$/.exec(p)
    if (!m) continue
    const [, block, rest] = m as unknown as [string, string, string]
    if (rest === 'block.yaml') s.blocks.set(block, yaml.parse<Block>(content))
    else if (/^(design|plan|digest)\.md$/.test(rest))
      s.docs.set(`${block}/${rest.slice(0, -3)}`, markdownToDoc(content))
    else if (/^(progress|steps|decisions)\.jsonl$/.test(rest))
      s.logs.set(`${block}/${rest.slice(0, -6)}`, jsonl.parse(content))
    else if (rest.startsWith('threads/')) {
      const t = yaml.parse<Thread & { seq: number }>(content)
      s.threads.set(t.id, t)
    }
  }
  return s
}

function readAll(dir: string): FileMap {
  const out: FileMap = new Map()
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (
        e.name === '.git' ||
        e.name === JOURNAL_DIR ||
        e.name === '.gitignore' ||
        e.name === '.lock'
      )
        continue
      const abs = join(d, e.name)
      if (e.isDirectory()) walk(abs)
      else if (!e.name.endsWith('.tmp')) out.set(relative(dir, abs), readFileSync(abs, 'utf8'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function diff(before: FileMap, after: FileMap): { writes: FileMap; deletes: string[] } {
  const writes: FileMap = new Map()
  for (const [p, c] of after) if (before.get(p) !== c) writes.set(p, c)
  const deletes = [...before.keys()].filter((p) => !after.has(p))
  return { writes, deletes }
}
