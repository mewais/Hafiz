// Relate: per focus block, the relation of every block to it. Pure.
import type { BlockId } from '../domain/types.js'
import type { Attrs } from './policy.js'
import type { Snapshot } from './snapshot.js'

export type Relation =
  | 'root'
  | 'focus'
  | 'ancestor'
  | 'dependency'
  | 'descendant'
  | 'dependent'
  | 'sibling'
  | 'other'

/** When several relations hold, the earliest wins. `root` always wins for the root block. */
export const RELATION_PRECEDENCE: readonly Relation[] = [
  'root',
  'focus',
  'ancestor',
  'dependency',
  'descendant',
  'dependent',
  'sibling',
  'other',
]

export interface Relatedness {
  relation: Relation
  /** Shortest `depends_on` path from the focus block, when within the view's dependency depth. */
  dep_distance?: number
}

/** BFS over an adjacency map, bounded by `maxDepth`. Returns distance per reached node (excl. start). */
function bfs(
  start: BlockId,
  adj: ReadonlyMap<BlockId, readonly BlockId[]>,
  maxDepth: number,
): Map<BlockId, number> {
  const dist = new Map<BlockId, number>()
  let frontier = [start]
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: BlockId[] = []
    for (const id of frontier)
      for (const n of adj.get(id) ?? [])
        if (n !== start && !dist.has(n)) {
          dist.set(n, d)
          next.push(n)
        }
    frontier = next
  }
  return dist
}

export function ancestorsOf(snap: Snapshot, id: BlockId): BlockId[] {
  const out: BlockId[] = []
  for (
    let p = snap.blocks.get(id)?.block.parentId ?? null;
    p && !out.includes(p);
    p = snap.blocks.get(p)?.block.parentId ?? null
  )
    out.push(p)
  return out
}

/**
 * Relation of every block to one focus block. `focus === null` means "no focus": the root is
 * `root`, everything else `other`.
 */
export function relateTo(
  snap: Snapshot,
  focus: BlockId | null,
  dependencyDepth: number,
): Map<BlockId, Relatedness> {
  const out = new Map<BlockId, Relatedness>()
  const ancestors = new Set(focus ? ancestorsOf(snap, focus) : [])
  const deps = focus ? bfs(focus, snap.dependsOn, dependencyDepth) : new Map<BlockId, number>()
  const dependents = focus
    ? bfs(focus, snap.dependents, dependencyDepth)
    : new Map<BlockId, number>()
  const parent = focus ? (snap.blocks.get(focus)?.block.parentId ?? null) : null
  for (const id of snap.treeOrder) {
    const dist = deps.get(id)
    let relation: Relation
    if (id === snap.rootId) relation = 'root'
    else if (!focus) relation = 'other'
    else if (id === focus) relation = 'focus'
    else if (ancestors.has(id)) relation = 'ancestor'
    else if (dist !== undefined) relation = 'dependency'
    else if (ancestorsOf(snap, id).includes(focus)) relation = 'descendant'
    else if (dependents.has(id)) relation = 'dependent'
    else if (parent !== null && snap.blocks.get(id)?.block.parentId === parent) relation = 'sibling'
    else relation = 'other'
    out.set(id, dist === undefined ? { relation } : { relation, dep_distance: dist })
  }
  return out
}

/** The attribute record rules match against. */
export function attrsFor(snap: Snapshot, id: BlockId, r: Relatedness): Attrs {
  const b = snap.blocks.get(id)?.block
  return {
    relation: r.relation,
    dep_distance: r.dep_distance,
    status: b?.status,
    kind: b?.kind,
    depth: snap.depth.get(id),
  }
}
