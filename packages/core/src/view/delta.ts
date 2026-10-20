// Delta channel: minor events (progress, step changes, thread changes) on a session's focus blocks
// and their dependencies since the session's cursor. Lives in the tail, never in the prefix (§6.5).
import type { BlockId, ProgressEntry, StepEvent, Thread } from '../domain/types.js'
import type { ReadOps } from '../store/backend.js'
import type { Tokenizer } from '../tokenizer.js'
import type { Snapshot } from './snapshot.js'

export interface DeltaResult {
  /** `<hafiz-delta>` … `</hafiz-delta>`, or '' when nothing happened. */
  text: string
  cursor: number
  /** Events rendered / events withheld by the cap. */
  shown: number
  withheld: number
}

export interface DeltaOptions {
  cursor: number
  blocks: ReadonlySet<BlockId>
  capTokens: number
  tokenizer: Tokenizer
  /** Progress and step events written by this session are not echoed back to it. */
  sessionId?: string
  pageSize?: number
}

/** Focus blocks plus their `depends_on` closure up to `depth`. */
export function deltaScope(snap: Snapshot, focus: readonly BlockId[], depth: number): Set<BlockId> {
  const out = new Set<BlockId>()
  let frontier = focus.filter((b) => snap.blocks.has(b))
  for (const b of frontier) out.add(b)
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: BlockId[] = []
    for (const id of frontier)
      for (const n of snap.dependsOn.get(id) ?? [])
        if (!out.has(n)) {
          out.add(n)
          next.push(n)
        }
    frontier = next
  }
  return out
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

export async function computeDelta(read: ReadOps, opts: DeltaOptions): Promise<DeltaResult> {
  const page = opts.pageSize ?? 500
  let cursor = opts.cursor
  type Item = { seq: number; block: BlockId; line: string; key?: string }
  const items: Item[] = []
  for (;;) {
    const rows = await read.readSince(cursor, page)
    if (!rows.length) break
    for (const r of rows) {
      cursor = Math.max(cursor, r.seq)
      if (!opts.blocks.has(r.block)) continue
      if (r.log === 'progress') {
        const p = r.entry as ProgressEntry
        if (opts.sessionId && p.by.sessionId === opts.sessionId) continue
        const refs = p.refs.length ? ` [${p.refs.join(', ')}]` : ''
        const who = p.by.agent ?? p.by.role
        items.push({
          seq: r.seq,
          block: r.block,
          line: `- [${r.block}] ${p.kind}: ${oneLine(p.text)}${refs} (${who})`,
        })
      } else if (r.log === 'steps') {
        const s = r.entry as StepEvent
        if (opts.sessionId && s.by.sessionId === opts.sessionId) continue
        items.push({
          seq: r.seq,
          block: r.block,
          line: `- [${r.block}] step ${s.stepId} → ${s.status}`,
          key: `step:${r.block}:${s.stepId}`,
        })
      } else if (r.log === 'threads') {
        const t = r.entry as Thread
        const last = t.status === 'parked' ? t.gist : t.entries[t.entries.length - 1]?.text
        items.push({
          seq: r.seq,
          block: r.block,
          line: `- [${r.block}] thread "${oneLine(t.title)}" \`${t.id}\` ${t.status}${last ? `: ${oneLine(last)}` : ''}`,
          key: `thread:${t.id}`,
        })
      }
    }
    if (rows.length < page) break
  }
  // Later writes to the same step or thread supersede earlier ones.
  const latest = new Map<string, number>()
  for (const it of items) if (it.key) latest.set(it.key, it.seq)
  const events = items.filter((it) => !it.key || latest.get(it.key) === it.seq)
  if (!events.length) return { text: '', cursor, shown: 0, withheld: 0 }

  const head = 'Since your last view:'
  const lines: string[] = []
  let used = opts.tokenizer.count(head)
  let i = 0
  for (; i < events.length; i++) {
    const n = opts.tokenizer.count((events[i] as Item).line)
    if (used + n > opts.capTokens) break
    lines.push((events[i] as Item).line)
    used += n
  }
  const rest = events.slice(i)
  const perBlock = new Map<BlockId, number>()
  for (const e of rest) perBlock.set(e.block, (perBlock.get(e.block) ?? 0) + 1)
  for (const [b, n] of perBlock) lines.push(`- ${n} more — block.read(${b})`)
  return {
    text: `<hafiz-delta>\n${head}\n${lines.join('\n')}\n</hafiz-delta>`,
    cursor,
    shown: i,
    withheld: rest.length,
  }
}
