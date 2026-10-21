// Read queries over the store (§5.2): the tree, its UI summary, one block in detail, doc history.

import {
  type Actor,
  type Block,
  type BlockedOn,
  type BlockId,
  type DecisionView,
  type Doc,
  type DocType,
  deriveDecisionStatus,
  type Edge,
  type ProgressEntry,
  type Standing,
  type Status,
  type StepEvent,
  type Thread,
} from '../domain/types.js'
import { snapshot } from '../view/service.js'
import { authorize } from './authz.js'
import { type CoreContext, mustBlock } from './tx.js'

export interface BlockDetail {
  block: Block
  docs: Partial<Record<DocType, Doc>>
  steps: StepEvent[]
  progress: ProgressEntry[]
  decisions: DecisionView[]
  threads: Thread[]
  edges: { dependsOn: Edge[]; dependents: Edge[] }
}

/** A decision as the TUI lists it. */
export interface DecisionBrief {
  id: string
  blockId: BlockId
  title: string
  decision: string
  ts: string
  standing?: Standing
}

export interface TreeSummaryNode {
  id: BlockId
  parentId: BlockId | null
  title: string
  kind: string
  status: Status
  order: number
  depth: number
  blockedOn?: BlockedOn
  /** Plan steps done (or skipped) of total; absent without a plan. */
  steps?: { done: number; total: number }
  docs: Record<DocType, number>
  /** Open and parked threads. */
  threads: Array<{ id: string; title: string; status: Thread['status'] }>
  /** Active decisions on the block. */
  decisions: number
  /** The latest active decisions, newest first. */
  recentDecisions: DecisionBrief[]
}

export interface TreeSummary {
  project: { id: string; name: string; epoch: number } | null
  /** Depth-first tree order. */
  nodes: TreeSummaryNode[]
  /** Active standing decisions (what the view floor carries), tree order. */
  standing: DecisionBrief[]
}

export type TreeRow = Pick<Block, 'id' | 'parentId' | 'title' | 'kind' | 'status' | 'order'> & {
  depth: number
}

export async function treeList(ctx: CoreContext, by: Actor): Promise<TreeRow[]> {
  authorize(ctx.config, by.role, 'tree.list')
  return treeListRaw(ctx)
}

export async function treeListRaw(ctx: CoreContext): Promise<TreeRow[]> {
  const all = await ctx.backend.read.listBlocks()
  const byParent = new Map<BlockId | null, Block[]>()
  for (const b of all) byParent.set(b.parentId, [...(byParent.get(b.parentId) ?? []), b])
  const out: TreeRow[] = []
  const walk = (parent: BlockId | null, depth: number) => {
    for (const b of (byParent.get(parent) ?? []).sort(
      (a, c) => a.order - c.order || a.createdAt.localeCompare(c.createdAt),
    )) {
      out.push({
        id: b.id,
        parentId: b.parentId,
        title: b.title,
        kind: b.kind,
        status: b.status,
        order: b.order,
        depth,
      })
      walk(b.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}

/**
 * The block tree with what a UI draws per row (step progress, blocked-on, thread and decision
 * counts, the latest active decisions) and the standing decisions of the floor. Read-only, one
 * snapshot; gated like `tree.list`.
 */
export async function treeSummary(
  ctx: CoreContext,
  by: Actor,
  opts: { recentDecisions?: number } = {},
): Promise<TreeSummary> {
  authorize(ctx.config, by.role, 'tree.list')
  const snap = await snapshot(ctx)
  const recent = opts.recentDecisions ?? 3
  const brief = (d: DecisionView): DecisionBrief => ({
    id: d.id,
    blockId: d.blockId,
    title: d.title,
    decision: d.decision,
    ts: d.ts,
    ...(d.standing ? { standing: d.standing } : {}),
  })
  const nodes: TreeSummaryNode[] = []
  const standing: DecisionBrief[] = []
  for (const id of snap.treeOrder) {
    const b = snap.blocks.get(id)
    if (!b) continue
    const active = b.decisions.filter((d) => d.status === 'active')
    for (const d of active) if (d.standing) standing.push(brief(d))
    const steps = b.steps
    nodes.push({
      id,
      parentId: b.block.parentId,
      title: b.block.title,
      kind: b.block.kind,
      status: b.block.status,
      order: b.block.order,
      depth: snap.depth.get(id) ?? 0,
      ...(b.block.blockedOn ? { blockedOn: b.block.blockedOn } : {}),
      ...(steps.length
        ? {
            steps: {
              done: steps.filter((x) => x.status === 'done' || x.status === 'skipped').length,
              total: steps.length,
            },
          }
        : {}),
      docs: b.block.docVersions,
      threads: b.threads
        .filter((t) => t.status !== 'resolved')
        .map((t) => ({ id: t.id, title: t.title, status: t.status })),
      decisions: active.length,
      recentDecisions: active.slice(-recent).reverse().map(brief),
    })
  }
  return {
    project: snap.project
      ? { id: snap.project.id, name: snap.project.name, epoch: snap.project.epoch }
      : null,
    nodes,
    standing,
  }
}

/** Version history of a block's docs, newest first; gated like `block.read`. */
export async function docHistory(ctx: CoreContext, by: Actor, id: BlockId, type?: DocType) {
  authorize(ctx.config, by.role, 'block.read')
  await mustBlock(ctx.backend.read, id)
  return ctx.backend.read.history(id, type)
}

export async function blockDetail(ctx: CoreContext, by: Actor, id: BlockId): Promise<BlockDetail> {
  authorize(ctx.config, by.role, 'block.read')
  return blockDetailRaw(ctx, id)
}

export async function blockDetailRaw(ctx: CoreContext, id: BlockId): Promise<BlockDetail> {
  const r = ctx.backend.read
  const block = await mustBlock(r, id)
  const docs: Partial<Record<DocType, Doc>> = {}
  for (const type of ['design', 'plan', 'digest'] as const) {
    const d = await r.getDoc(id, type)
    if (d) docs[type] = d
  }
  const edges = await r.listEdges()
  return {
    block,
    docs,
    steps: (await r.readLog(id, 'steps')).map((x) => x.entry),
    progress: (await r.readLog(id, 'progress')).map((x) => x.entry),
    decisions: deriveDecisionStatus((await r.readLog(id, 'decisions')).map((x) => x.entry)),
    threads: await r.listThreads(id),
    edges: {
      dependsOn: edges.filter((e) => e.from === id),
      dependents: edges.filter((e) => e.to === id),
    },
  }
}
