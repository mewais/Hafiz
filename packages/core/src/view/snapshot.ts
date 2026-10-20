// Snapshot: everything the view engine needs, loaded once through ReadOps into plain immutable
// data. Everything downstream of `loadSnapshot` is a pure function of the snapshot.
import {
  type Block,
  type BlockId,
  type DecisionView,
  type Doc,
  type DocType,
  deriveDecisionStatus,
  type Edge,
  type ProgressEntry,
  type Project,
  type Step,
  type StepStatus,
  type Thread,
} from '../domain/types.js'
import type { ReadOps } from '../store/backend.js'

/** A plan step with its status folded from the step-event log (last event wins). */
export interface FoldedStep extends Step {
  status: StepStatus
}

export interface BlockSnap {
  readonly block: Block
  readonly docs: Readonly<Partial<Record<DocType, Doc>>>
  /** Plan steps in plan order, status folded from step events; empty without a plan. */
  readonly steps: readonly FoldedStep[]
  /** The last `progressLast` progress entries, oldest first. */
  readonly progress: readonly ProgressEntry[]
  /** All decisions with derived status, oldest first. */
  readonly decisions: readonly DecisionView[]
  /** All threads, ordered by creation then id. */
  readonly threads: readonly Thread[]
}

export interface Snapshot {
  readonly project: Project | null
  readonly rootId: BlockId | null
  readonly blocks: ReadonlyMap<BlockId, BlockSnap>
  /** Children per parent, sorted by (order, createdAt, id). */
  readonly children: ReadonlyMap<BlockId, readonly BlockId[]>
  /** Every block id in depth-first tree order. */
  readonly treeOrder: readonly BlockId[]
  readonly depth: ReadonlyMap<BlockId, number>
  /** `depends_on` adjacency: from → [to], and the reverse. Sorted for determinism. */
  readonly dependsOn: ReadonlyMap<BlockId, readonly BlockId[]>
  readonly dependents: ReadonlyMap<BlockId, readonly BlockId[]>
  readonly edges: readonly Edge[]
}

export const DEPENDS_ON = 'depends_on'

export function foldSteps(
  plan: Doc | undefined,
  events: ReadonlyArray<{ stepId: string; status: StepStatus }>,
): FoldedStep[] {
  const steps = (plan?.sections.steps ?? []) as Step[]
  if (!Array.isArray(steps)) return []
  const last = new Map<string, StepStatus>()
  for (const e of events) last.set(e.stepId, e.status)
  return steps.map((s) => ({ ...s, status: last.get(s.id) ?? 'todo' }))
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    if (v instanceof Map) for (const x of v.values()) deepFreeze(x)
    else for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

const byOrder = (a: Block, b: Block) =>
  a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/** Pure assembly from already-loaded parts (used by `loadSnapshot` and by tests). */
export function buildSnapshot(parts: {
  project: Project | null
  blocks: Block[]
  edges: Edge[]
  per: Map<BlockId, Omit<BlockSnap, 'block'>>
}): Snapshot {
  const blocks = new Map<BlockId, BlockSnap>()
  const sorted = [...parts.blocks].sort(byOrder)
  for (const b of sorted) {
    const p = parts.per.get(b.id)
    blocks.set(b.id, {
      block: b,
      docs: p?.docs ?? {},
      steps: p?.steps ?? [],
      progress: p?.progress ?? [],
      decisions: p?.decisions ?? [],
      threads: p?.threads ?? [],
    })
  }
  const children = new Map<BlockId, BlockId[]>()
  const roots: BlockId[] = []
  for (const b of sorted) {
    if (b.parentId === null || !blocks.has(b.parentId)) roots.push(b.id)
    else children.set(b.parentId, [...(children.get(b.parentId) ?? []), b.id])
  }
  const rootId =
    parts.project?.rootBlockId && blocks.has(parts.project.rootBlockId)
      ? parts.project.rootBlockId
      : (roots[0] ?? null)
  const treeOrder: BlockId[] = []
  const depth = new Map<BlockId, number>()
  const walk = (id: BlockId, d: number) => {
    if (depth.has(id)) return // defensive against cycles
    depth.set(id, d)
    treeOrder.push(id)
    for (const c of children.get(id) ?? []) walk(c, d + 1)
  }
  for (const r of rootId ? [rootId, ...roots.filter((x) => x !== rootId)] : roots) walk(r, 0)

  const dependsOn = new Map<BlockId, BlockId[]>()
  const dependents = new Map<BlockId, BlockId[]>()
  const edges = [...parts.edges].sort(
    (a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind),
  )
  for (const e of edges) {
    if (e.kind !== DEPENDS_ON || !blocks.has(e.from) || !blocks.has(e.to)) continue
    dependsOn.set(e.from, [...(dependsOn.get(e.from) ?? []), e.to])
    dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from])
  }
  return deepFreeze({
    project: parts.project,
    rootId,
    blocks,
    children,
    treeOrder,
    depth,
    dependsOn,
    dependents,
    edges,
  })
}

/** Load the snapshot. `progressLast` bounds the progress entries read per block. */
export async function loadSnapshot(
  read: ReadOps,
  opts: { progressLast?: number } = {},
): Promise<Snapshot> {
  const progressLast = opts.progressLast ?? 10
  const [project, blocks, edges, threads] = await Promise.all([
    read.getProject(),
    read.listBlocks(),
    read.listEdges(),
    read.listThreads(),
  ])
  const threadsBy = new Map<BlockId, Thread[]>()
  for (const t of threads) threadsBy.set(t.blockId, [...(threadsBy.get(t.blockId) ?? []), t])
  const per = new Map<BlockId, Omit<BlockSnap, 'block'>>()
  for (const b of blocks) {
    const docs: Partial<Record<DocType, Doc>> = {}
    for (const type of ['design', 'plan', 'digest'] as const) {
      if (!b.docVersions[type]) continue
      const d = await read.getDoc(b.id, type)
      if (d) docs[type] = d
    }
    const steps = (await read.readLog(b.id, 'steps')).map((r) => r.entry)
    const progress = progressLast
      ? (await read.readLog(b.id, 'progress', { last: progressLast })).map((r) => r.entry)
      : []
    const decisions = deriveDecisionStatus(
      (await read.readLog(b.id, 'decisions')).map((r) => r.entry),
    )
    per.set(b.id, {
      docs,
      steps: foldSteps(docs.plan, steps),
      progress,
      decisions,
      threads: (threadsBy.get(b.id) ?? []).sort(
        (x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id),
      ),
    })
  }
  return buildSnapshot({ project, blocks, edges, per })
}
