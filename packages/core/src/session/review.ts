// How a review-queue entry reads to a human or a manager agent: where it came from, what it
// says, and what accepting it does (the exact command, or pinning a design/plan version).
import type { Proposal, ReviewMode } from '../domain/types.js'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** `decision.record {"block":"blk_a","title":"…"}` — args clipped so a line stays a line. */
export function suggestedCommand(p: Pick<Proposal, 'payload'>): string {
  const args = Object.entries(p.payload.args).map(([k, v]) => [
    k,
    typeof v === 'string' ? clip(v, 80) : v,
  ])
  return `${p.payload.command} ${JSON.stringify(Object.fromEntries(args))}`
}

/** A proposal with what the review queue adds when listing it (`ReviewItem`). */
type Listed = Proposal & { mode?: ReviewMode; blockTitle?: string; version?: number }

/**
 * Header line (id, kind and version, source, block, table row), note and what accepting does,
 * as indented text lines.
 */
export function describeProposal(p: Listed): string[] {
  const kind = p.version !== undefined ? `${p.kind} v${p.version}` : p.kind
  const block = `${p.blockId ?? '-'}${p.blockTitle !== undefined ? ` '${p.blockTitle}'` : ''}`
  const lines = [`${p.id}  ${kind}  from ${p.source}  on ${block}${p.mode ? `  ${p.mode}` : ''}`]
  if (p.note) lines.push(`    ${p.note}`)
  if (p.resolutionNote) lines.push(`    ${p.status}: ${p.resolutionNote}`)
  lines.push(
    p.source === 'review'
      ? `    accept pins v${p.version ?? '?'}: hafiz review --accept ${p.id} · read it: hafiz review --show ${p.id}`
      : `    accept runs: ${suggestedCommand(p)}`,
  )
  return lines
}
