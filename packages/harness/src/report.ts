// Reports: one compact markdown table per task (means over --repeat runs), the JSON the
// `compare` command diffs, and the baseline-vs-tuned diff itself.
import type { MetricSet, MetricValue, RunMetrics } from './metrics.js'
import type { RunResult } from './runner.js'
import { flatten } from './score.js'

export interface Report {
  version: 1
  createdAt: string
  model: string
  mock: boolean
  results: RunResult[]
}

export function buildReport(
  results: RunResult[],
  meta: { model: string; mock: boolean; now?: Date },
): Report {
  return {
    version: 1,
    createdAt: (meta.now ?? new Date()).toISOString(),
    model: meta.model,
    mock: meta.mock,
    results,
  }
}

/** Rows shown in the per-run table: [metric key, label]. Zero-everywhere rows are hidden. */
const ROWS: Array<[string, string, boolean?]> = [
  ['sessions', 'sessions', true],
  ['decisions', 'decisions'],
  ['decisions_standing', '  of which standing'],
  ['progress', 'progress entries', true],
  ['steps', 'step events'],
  ['threads_opened', 'threads opened'],
  ['threads_parked', 'threads parked'],
  ['request_done', 'request_done', true],
  ['request_done_digest', '  with digest'],
  ['reports', 'reports captured'],
  ['cap_rejections', 'cap rejections'],
  ['retries', 'retries after reject'],
  ['compliance_notices', 'compliance notices'],
  ['hafiz_calls', 'protocol tool calls'],
  ['tool_calls', 'all tool calls', true],
  ['protocol_ratio', 'protocol / all'],
  ['files_written', 'files written'],
  ['view_emits', 'view re-emits'],
  ['tokens_per_view', 'tokens per view'],
  ['cache_read_ratio', 'cache read ratio'],
  ['condensations', 'condensations'],
  ['hafiz_writes', 'hafiz writes'],
]

const ROLE_ORDER = ['manager', 'designer', 'planner', 'worker']

export function fmt(key: string, v: MetricValue | undefined): string {
  if (v === null || v === undefined) return '-'
  if (key.endsWith('_ratio')) return `${Math.round(v * 100)}%`
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

/** Mean of each metric over runs (null when no run measured it). */
export function meanMetrics(all: readonly RunMetrics[]): RunMetrics {
  const mean = (sets: MetricSet[]): MetricSet => {
    const out: MetricSet = {}
    for (const k of new Set(sets.flatMap((s) => Object.keys(s)))) {
      const vs = sets.map((s) => s[k]).filter((v): v is number => typeof v === 'number')
      out[k] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null
    }
    return out
  }
  const roles = [...new Set(all.flatMap((m) => Object.keys(m.roles)))]
  return {
    total: mean(all.map((m) => m.total)),
    roles: Object.fromEntries(
      roles.map((r) => [r, mean(all.flatMap((m) => (m.roles[r] ? [m.roles[r]] : [])))]),
    ),
  }
}

const mdRow = (cells: string[]) => `| ${cells.join(' | ')} |`

function taskTable(rs: RunResult[]): string[] {
  const first = rs[0] as RunResult
  const m = meanMetrics(rs.map((r) => r.metrics))
  const roles = ROLE_ORDER.filter((r) => m.roles[r]).concat(
    Object.keys(m.roles).filter((r) => !ROLE_ORDER.includes(r)),
  )
  const cols = [...roles, 'all']
  const get = (col: string, k: string) => (col === 'all' ? m.total[k] : m.roles[col]?.[k])
  const lines = [mdRow(['metric', ...cols]), mdRow(['---', ...cols.map(() => '---:')])]
  for (const [k, label, always] of ROWS) {
    const vals = cols.map((c) => get(c, k))
    if (!always && vals.every((v) => !v)) continue
    lines.push(mdRow([label, ...vals.map((v) => fmt(k, v))]))
  }
  const ok = rs.filter((r) => r.passed).length
  const props = ['condenser', 'drafter', 'compliance', 'auto_done']
    .map((s) => [s, m.total[`proposals_${s}`]] as const)
    .filter(([, v]) => v)
    .map(([s, v]) => `${s}=${fmt('', v)}`)
  const out = [
    `### ${first.task} (${first.size}) — ${ok}/${rs.length} passed`,
    '',
    ...lines,
    ...(props.length ? ['', `proposals: ${props.join(', ')}`] : []),
  ]
  const exp = first.expectations.map((e, i) => {
    const hits = rs.filter((r) => r.expectations[i]?.pass).length
    const got = rs.map((r) => fmt(e.metric, r.expectations[i]?.got)).join(' / ')
    return mdRow([e.metric, e.want, got, hits === rs.length ? 'ok' : `FAIL ${hits}/${rs.length}`])
  })
  if (exp.length)
    out.push('', mdRow(['expect', 'want', 'got', '']), mdRow(['---', '---', '---', '---']), ...exp)
  const errs = rs.filter((r) => r.error).map((r) => `run ${r.repeat}: ${r.error}`)
  if (errs.length) out.push('', ...errs.map((e) => `error: ${e}`))
  return out
}

const byTask = (results: readonly RunResult[]) => {
  const m = new Map<string, RunResult[]>()
  for (const r of results) m.set(r.task, [...(m.get(r.task) ?? []), r])
  return m
}

export function renderMarkdown(report: Report): string {
  const head = `## Hafiz compliance harness — ${report.model}${report.mock ? ' (mock)' : ''} — ${report.createdAt.slice(0, 16)}Z`
  const groups = byTask(report.results)
  const overview = [
    mdRow(['task', 'size', 'passed', 'turns ok', 'wall s']),
    mdRow(['---', '---', '---:', '---:', '---:']),
    ...[...groups.values()].map((rs) => {
      const r0 = rs[0] as RunResult
      const turnsOk = rs.reduce((n, r) => n + r.turns.filter((t) => t.code === 0).length, 0)
      const turns = rs.reduce((n, r) => n + r.turns.length, 0)
      const wall = rs.reduce((n, r) => n + r.wallMs, 0) / rs.length / 1000
      return mdRow([
        r0.task,
        r0.size,
        `${rs.filter((r) => r.passed).length}/${rs.length}`,
        `${turnsOk}/${turns}`,
        wall.toFixed(0),
      ])
    }),
  ]
  return [
    head,
    '',
    ...overview,
    ...[...groups.values()].flatMap((rs) => ['', ...taskTable(rs)]),
    '',
  ].join('\n')
}

// ───────────────────────────── compare ─────────────────────────────

/** Metrics worth diffing (the ROWS keys), per role and total. */
export function compareReports(a: Report, b: Report): string {
  const ga = byTask(a.results)
  const gb = byTask(b.results)
  const out = [
    `## Compare — A: ${a.model}${a.mock ? ' (mock)' : ''} ${a.createdAt.slice(0, 16)}Z · B: ${b.model}${b.mock ? ' (mock)' : ''} ${b.createdAt.slice(0, 16)}Z`,
  ]
  for (const [task, ra] of ga) {
    const rb = gb.get(task)
    if (!rb) {
      out.push('', `### ${task}: only in A`)
      continue
    }
    const fa = flatten(meanMetrics(ra.map((r) => r.metrics)))
    const fb = flatten(meanMetrics(rb.map((r) => r.metrics)))
    const keys = new Set(ROWS.map(([k]) => k))
    const rows: string[] = []
    for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])]) {
      const base = k.includes('.') ? (k.split('.')[1] as string) : k
      if (!keys.has(base)) continue
      const va = fa[k] ?? null
      const vb = fb[k] ?? null
      if (va === vb) continue
      const d = va !== null && vb !== null ? vb - va : null
      rows.push(
        mdRow([
          k,
          fmt(base, va),
          fmt(base, vb),
          d === null
            ? '-'
            : `${d > 0 ? '+' : ''}${base.endsWith('_ratio') ? `${Math.round(d * 100)}pp` : Number.isInteger(d) ? d : d.toFixed(2)}`,
        ]),
      )
    }
    const pa = ra.filter((r) => r.passed).length
    const pb = rb.filter((r) => r.passed).length
    out.push('', `### ${task} — passed A ${pa}/${ra.length}, B ${pb}/${rb.length}`)
    if (rows.length)
      out.push(
        '',
        mdRow(['metric', 'A', 'B', 'Δ']),
        mdRow(['---', '---:', '---:', '---:']),
        ...rows,
      )
    else out.push('', 'no metric differs.')
    const ea = new Map(ra[0]?.expectations.map((e) => [e.metric, e]))
    const flips = (rb[0]?.expectations ?? []).filter((e) => ea.get(e.metric)?.pass !== e.pass)
    for (const e of flips)
      out.push(
        '',
        `expectation ${e.metric} ${e.want}: ${ea.get(e.metric)?.pass ? 'pass → FAIL' : 'FAIL → pass'}`,
      )
  }
  for (const task of gb.keys()) if (!ga.has(task)) out.push('', `### ${task}: only in B`)
  out.push('')
  return out.join('\n')
}
