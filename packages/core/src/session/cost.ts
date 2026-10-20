// Cost instrumentation (§7): everything is a plain session counter, summed per project. The
// "cheaper than summarization" thesis is measured from these numbers, not asserted.
import type { Session } from '../domain/types.js'

/** Counter names written by Core, the daemon and the host adapter. */
export const COST = {
  viewEmits: 'view_emits',
  viewTokens: 'view_tokens',
  deltaTokens: 'delta_tokens',
  condensations: 'condensations',
  condenseTokensIn: 'condense_tokens_in',
  condenseTokensOut: 'condense_tokens_out',
  condenseFailures: 'condense_failures',
  wireRequests: 'wire_requests',
  wireInput: 'wire_input',
  wireOutput: 'wire_output',
  wireCacheRead: 'wire_cache_read',
  wireCacheWrite: 'wire_cache_write',
} as const

export interface CostRow {
  id: string
  role: string
  viewEmits: number
  tokensPerView: number
  deltaTokens: number
  /** cache_read / (input + cache_read + cache_write); null when nothing was measured. */
  cacheHit: number | null
  condensations: number
  condenseTokens: number
}

const c = (s: Pick<Session, 'counters'>, k: string) => s.counters[k] ?? 0

export function costRow(s: Pick<Session, 'id' | 'role' | 'counters'>): CostRow {
  // The proxy sees every wire request; Kilo's own per-message tokens are the fallback.
  const wire = c(s, COST.wireRequests) > 0
  const read = wire ? c(s, COST.wireCacheRead) : c(s, 'cache_read')
  const write = wire ? c(s, COST.wireCacheWrite) : c(s, 'cache_write')
  const input = wire ? c(s, COST.wireInput) : c(s, 'tokens_in')
  const total = input + read + write
  const emits = c(s, COST.viewEmits)
  return {
    id: s.id,
    role: s.role,
    viewEmits: emits,
    tokensPerView: emits ? Math.round(c(s, COST.viewTokens) / emits) : 0,
    deltaTokens: c(s, COST.deltaTokens),
    cacheHit: total > 0 ? read / total : null,
    condensations: c(s, COST.condensations),
    condenseTokens: c(s, COST.condenseTokensIn) + c(s, COST.condenseTokensOut),
  }
}

export function costTotal(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'role' | 'counters'>>,
): CostRow {
  const sum: Record<string, number> = {}
  for (const s of sessions)
    for (const [k, v] of Object.entries(s.counters)) sum[k] = (sum[k] ?? 0) + v
  return costRow({ id: 'total', role: '', counters: sum })
}

/** Compact plain-text table for `hafiz status`. */
export function renderCostTable(
  sessions: ReadonlyArray<Pick<Session, 'id' | 'role' | 'counters'>>,
): string[] {
  const rows = [...sessions.map(costRow), ...(sessions.length > 1 ? [costTotal(sessions)] : [])]
  const head = [
    'session',
    'role',
    're-emits',
    'tok/view',
    'delta tok',
    'cache hit',
    'condense',
    'cond. tok',
  ]
  const cell = (r: CostRow) => [
    r.id.length > 22 ? `${r.id.slice(0, 21)}…` : r.id,
    r.role,
    String(r.viewEmits),
    String(r.tokensPerView),
    String(r.deltaTokens),
    r.cacheHit === null ? '-' : `${Math.round(r.cacheHit * 100)}%`,
    String(r.condensations),
    String(r.condenseTokens),
  ]
  const body = rows.map(cell)
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] as string).length)))
  const fmt = (cols: string[]) =>
    cols
      .map((x, i) => (i < 2 ? x.padEnd(widths[i] as number) : x.padStart(widths[i] as number)))
      .join('  ')
      .trimEnd()
  return [fmt(head), ...body.map(fmt)]
}
