// Portable store snapshot for `hafiz export` / `hafiz import`: the project's durable content
// (blocks, current docs, logs, threads, edges). Sessions, proposals, audit and counters are
// runtime state and are not exported.
import { ValidationError } from '../domain/errors.js'
import { opaqueId } from '../domain/ids.js'
import {
  type Actor,
  type Block,
  DOC_TYPES,
  type Doc,
  type Edge,
  type Project,
  type Thread,
} from '../domain/types.js'
import type { LogName, StorageBackend } from './backend.js'

export const SNAPSHOT_FORMAT = 'hafiz-snapshot'

export interface SnapshotRecord {
  seq: number
  block: string
  log: LogName | 'threads'
  entry: unknown
}

export interface StoreSnapshot {
  format: typeof SNAPSHOT_FORMAT
  version: 1
  exportedAt: string
  project: Project
  blocks: Block[]
  docs: Doc[]
  edges: Edge[]
  /** Log entries and threads in sequence order. */
  records: SnapshotRecord[]
}

export async function exportStore(backend: StorageBackend, now: string): Promise<StoreSnapshot> {
  const r = backend.read
  const project = await r.getProject()
  if (!project) throw new ValidationError('nothing to export: the store has no project')
  const blocks = await r.listBlocks()
  const docs: Doc[] = []
  for (const b of blocks)
    for (const type of DOC_TYPES) {
      const d = await r.getDoc(b.id, type)
      if (d) docs.push(d)
    }
  const records = (await r.readSince(0, Number.MAX_SAFE_INTEGER)).map((x) => ({
    seq: x.seq,
    block: x.block,
    log: x.log,
    entry: x.entry,
  }))
  return {
    format: SNAPSHOT_FORMAT,
    version: 1,
    exportedAt: now,
    project,
    blocks,
    docs,
    edges: await r.listEdges(),
    records,
  }
}

export function parseSnapshot(text: string): StoreSnapshot {
  let s: StoreSnapshot
  try {
    s = JSON.parse(text) as StoreSnapshot
  } catch {
    throw new ValidationError('not a Hafiz snapshot: invalid JSON')
  }
  if (s?.format !== SNAPSHOT_FORMAT || s.version !== 1 || !s.project || !Array.isArray(s.blocks))
    throw new ValidationError(`not a Hafiz snapshot (expected format '${SNAPSHOT_FORMAT}' v1)`)
  return s
}

/**
 * Load a snapshot into an empty store. With `asNew` the project gets a fresh id and the given
 * fingerprint (a copy that must not be mistaken for the original); otherwise both are kept.
 */
export async function importStore(
  backend: StorageBackend,
  snap: StoreSnapshot,
  by: Actor,
  opts: { asNew?: { fingerprint: string; id?: string } | undefined } = {},
): Promise<Project> {
  if (await backend.read.getProject())
    throw new ValidationError('the target store is not empty; import needs an empty store')
  const project: Project = opts.asNew
    ? {
        ...snap.project,
        id: opts.asNew.id ?? opaqueId('prj', 4),
        originFingerprint: opts.asNew.fingerprint,
      }
    : snap.project
  await backend.tx(
    { by, command: 'project.import', major: true, message: 'hafiz: import snapshot' },
    async (t) => {
      await t.putProject(project)
      for (const b of snap.blocks) await t.putBlock(b, -1)
      for (const d of snap.docs) await t.putDoc(d, 0)
      for (const e of snap.edges) await t.putEdge(e)
      for (const rec of [...snap.records].sort((a, b) => a.seq - b.seq)) {
        if (rec.log === 'threads') {
          const { seq: _seq, ...thread } = rec.entry as Thread & { seq?: number }
          await t.putThread(thread as Thread)
        } else await t.appendLog(rec.block, rec.log, rec.entry as never)
      }
    },
  )
  return project
}
