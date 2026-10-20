// How a review-queue entry reads to a human or a manager agent: where it came from, what it
// says, and the exact command that accepting it would run.
import type { Proposal } from '../domain/types.js'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** `decision.record {"block":"blk_a","title":"…"}` — args clipped so a line stays a line. */
export function suggestedCommand(p: Pick<Proposal, 'payload'>): string {
  const args = Object.entries(p.payload.args).map(([k, v]) => [
    k,
    typeof v === 'string' ? clip(v, 80) : v,
  ])
  return `${p.payload.command} ${JSON.stringify(Object.fromEntries(args))}`
}

/** Header line, note and suggested command, as indented text lines. */
export function describeProposal(p: Proposal): string[] {
  const lines = [`${p.id}  ${p.kind}  from ${p.source}  on ${p.blockId ?? '-'}`]
  if (p.note) lines.push(`    ${p.note}`)
  lines.push(`    accept runs: ${suggestedCommand(p)}`)
  return lines
}
