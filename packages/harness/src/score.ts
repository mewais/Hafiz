// Expectation scoring: a task's `expect` map (metric -> condition) against the collected metrics.
import type { MetricValue, RunMetrics } from './metrics.js'

export interface Expectation {
  metric: string
  want: string
  got: MetricValue | undefined
  pass: boolean
}

const OPS = {
  '>=': (a: number, b: number) => a >= b,
  '<=': (a: number, b: number) => a <= b,
  '==': (a: number, b: number) => a === b,
  '!=': (a: number, b: number) => a !== b,
  '>': (a: number, b: number) => a > b,
  '<': (a: number, b: number) => a < b,
} as const

/** Does `got` satisfy `want` (`">=1"`, `"==3"`, `"1..3"`, or a bare number meaning ==)? */
export function holds(want: string | number, got: MetricValue | undefined): boolean {
  if (got === null || got === undefined) return false
  const w = String(want).trim()
  const range = /^(-?\d+(?:\.\d+)?)\.\.(-?\d+(?:\.\d+)?)$/.exec(w)
  if (range) return got >= Number(range[1]) && got <= Number(range[2])
  const m = /^(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?)$/.exec(w)
  if (!m) throw new Error(`bad expectation '${w}' (use >=1, ==3, 1..3 or a number)`)
  return OPS[(m[1] ?? '==') as keyof typeof OPS](got, Number(m[2]))
}

/**
 * Metric lookup: `decisions_standing` is a total over agent sessions; `worker_done_requests`
 * (or `workers_done_requests`) is the same metric for one role.
 */
export function lookup(metrics: RunMetrics, key: string): MetricValue | undefined {
  if (key in metrics.total) return metrics.total[key]
  const role = /^(manager|designer|planner|worker)s?_(.+)$/.exec(key)
  if (!role) return undefined
  const [, name, metric] = role as unknown as [string, string, string]
  const set = metrics.roles[name]
  // a role with no session did nothing: its counts are 0 (`designer_sessions <=4` holds)
  if (!set) return metric in metrics.total ? 0 : undefined
  return set[metric]
}

/** `a or b`: the alternatives of an expectation key. */
const alternatives = (key: string) => key.split(/\s+or\s+/).map((k) => k.trim())

export function scoreExpectations(
  expect: Readonly<Record<string, string | number>>,
  metrics: RunMetrics,
): Expectation[] {
  return Object.entries(expect).map(([metric, want]) => {
    const values = alternatives(metric).map((k) => lookup(metrics, k))
    const i = values.findIndex((v) => holds(want, v))
    const got = values[Math.max(i, 0)]
    return { metric, want: String(want), got, pass: i >= 0 }
  })
}

/** Flat `name -> value` view (totals, then `role.name`), for reports and comparisons. */
export function flatten(metrics: RunMetrics): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = { ...metrics.total }
  for (const [role, set] of Object.entries(metrics.roles))
    for (const [k, v] of Object.entries(set)) out[`${role}.${k}`] = v
  return out
}
