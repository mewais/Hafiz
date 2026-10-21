// Block references as people and agents type them: an exact id, a unique id prefix, or a unique
// case-insensitive title. Shared by the CLI and the Kilo plugin's `task` check.

export interface BlockRef {
  id: string
  title: string
}

export type BlockMatch =
  | { id: string }
  | { ambiguous: BlockRef[]; by: 'id prefix' | 'title' }
  | { none: true }

/** Resolve `ref` against `blocks`: exact id, then unique id prefix, then unique title. */
export function matchBlock(blocks: readonly BlockRef[], ref: string): BlockMatch {
  if (blocks.some((b) => b.id === ref)) return { id: ref }
  const byPrefix = blocks.filter((b) => b.id.startsWith(ref))
  if (byPrefix.length === 1) return { id: (byPrefix[0] as BlockRef).id }
  if (byPrefix.length > 1) return { ambiguous: byPrefix, by: 'id prefix' }
  const lower = ref.toLowerCase()
  const byTitle = blocks.filter((b) => b.title.toLowerCase() === lower)
  if (byTitle.length === 1) return { id: (byTitle[0] as BlockRef).id }
  if (byTitle.length > 1) return { ambiguous: byTitle, by: 'title' }
  return { none: true }
}

/** `  blk_x — Title` lines, for error messages. */
export const blockList = (blocks: readonly BlockRef[]) =>
  blocks.map((b) => `  ${b.id} — ${b.title}`).join('\n')
