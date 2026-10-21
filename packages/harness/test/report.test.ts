// Task files, the report table and the baseline-vs-tuned diff (no Kilo, no model).
import { describe, expect, it } from 'vitest'
import type { RunMetrics } from '../src/metrics.js'
import { buildReport, compareReports, meanMetrics, renderMarkdown } from '../src/report.js'
import type { RunResult } from '../src/runner.js'
import { scoreExpectations } from '../src/score.js'
import { loadTasks, parseTask } from '../src/tasks.js'

const metrics = (over: Partial<Record<string, number | null>> = {}): RunMetrics => ({
  total: {
    sessions: 2,
    progress: 2,
    done_requests: 1,
    tool_calls: 10,
    protocol_ratio: 0.5,
    ...over,
  },
  roles: { worker: { sessions: 1, progress: 2, done_requests: 1, ...over } },
})
const result = (m: RunMetrics, repeat = 1): RunResult => ({
  task: 't',
  size: 'M',
  repeat,
  model: 'p/m',
  mock: false,
  passed: true,
  turns: [{ agent: 'build', code: 0, ms: 5 }],
  wallMs: 5000,
  metrics: m,
  expectations: scoreExpectations({ progress: '>=2', done_requests: '==1' }, m),
})

describe('task files', () => {
  it('ships S, M and L tasks that parse', () => {
    const tasks = loadTasks()
    expect(tasks.map((t) => t.size).sort()).toEqual(['L', 'M', 'S'])
    for (const t of tasks) {
      expect(t.turns.length).toBeGreaterThan(0)
      expect(Object.keys(t.expect).length).toBeGreaterThan(0)
      // every scripted turn is one of the task's turns
      for (const s of t.mock) expect(s.turn).toBeLessThanOrEqual(t.turns.length)
    }
    expect(loadTasks(undefined, ['L']).map((t) => t.id)).toEqual(['l-seeded-tree'])
  })

  it('rejects a bad task with its path', () => {
    expect(() => parseTask('id: x\nsize: XL', 'bad.yaml')).toThrow(/bad\.yaml/)
  })
})

describe('report', () => {
  it('renders one compact table per task with expectations', () => {
    const md = renderMarkdown(buildReport([result(metrics())], { model: 'p/m', mock: false }))
    expect(md).toContain('### t (M) — 1/1 passed')
    expect(md).toContain('| progress entries | 2 | 2 |')
    expect(md).toContain('| protocol / all | - | 50% |')
    expect(md).toContain('| progress | >=2 | 2 | ok |')
  })

  it('averages repeats and reports the pass rate', () => {
    const a = result(metrics({ progress: 1 }), 1)
    a.passed = false
    a.expectations = scoreExpectations({ progress: '>=2' }, a.metrics)
    const b = result(metrics({ progress: 3 }), 2)
    expect(meanMetrics([a.metrics, b.metrics]).total.progress).toBe(2)
    const md = renderMarkdown(buildReport([a, b], { model: 'p/m', mock: false }))
    expect(md).toContain('1/2 passed')
    expect(md).toContain('FAIL 1/2')
  })

  it('compares a baseline with a tuned run', () => {
    const run = (m: RunMetrics) => ({
      ...result(m),
      expectations: scoreExpectations({ progress: '>=2' }, m),
    })
    const base = buildReport([run(metrics({ progress: 1, cap_rejections: 2 }))], {
      model: 'p/m',
      mock: false,
    })
    const tuned = buildReport([run(metrics({ progress: 4 }))], { model: 'p/m', mock: false })
    const md = compareReports(base, tuned)
    expect(md).toContain('| progress | 1 | 4 | +3 |')
    expect(md).toContain('| worker.progress | 1 | 4 | +3 |')
    expect(md).toContain('| cap_rejections | 2 | - | - |')
    expect(md).not.toContain('| sessions |') // unchanged rows are hidden
    expect(md).toContain('expectation progress >=2: FAIL → pass')
  })
})
