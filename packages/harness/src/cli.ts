// hafiz-harness: run | compare | report | tasks
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildReport, compareReports, type Report, renderMarkdown } from './report.js'
import { MOCK_MODEL, type RunResult, resolveKilo, runTask } from './runner.js'
import { DEFAULT_TASKS_DIR, loadTasks, TIERS, type Tier } from './tasks.js'

const USAGE = `hafiz-harness — compliance harness for Hafiz on Kilo

  run      --model provider/model [--model …] [--tasks dir|file[,…]] [--only S,M,<id>]
           [--tier smoke|full]           (default smoke: S, M gated, L, once each; full: every
                                          task, --repeat times)
           [--fail-fast | --no-fail-fast] (stop a task at the first missed per-turn check;
                                          default on in smoke, off in full)
           [--repeat N] [--kilo-bin path] [--out dir] [--shaper proxy|hooks|auto] [--keep] [--isolate]
           [--turn-timeout seconds]      (per Kilo turn; default 1800)
           [--mock]                      (scripted mock LLM instead of a model; no --model needed)
  compare  a.json b.json                 diff a baseline run against a tuned one
  report   run.json                      print a result file as the markdown table
  tasks    [--tasks dir|file[,…]]        list the task set
`

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

const split = (s: string | undefined) =>
  s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : []
const slug = (s: string) => s.replace(/[^\w.-]+/g, '_')
const readReport = (p: string): Report => JSON.parse(readFileSync(resolve(p), 'utf8')) as Report

export async function main(argv: string[], io: CliIo): Promise<number> {
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case 'run':
        return await runCommand(rest, io)
      case 'compare': {
        const [a, b] = rest
        if (!a || !b) throw new Error('usage: hafiz-harness compare a.json b.json')
        io.out(compareReports(readReport(a), readReport(b)))
        return 0
      }
      case 'report': {
        if (!rest[0]) throw new Error('usage: hafiz-harness report run.json')
        io.out(renderMarkdown(readReport(rest[0])))
        return 0
      }
      case 'tasks': {
        const { values } = parseArgs({ args: rest, options: { tasks: { type: 'string' } } })
        for (const t of loadTasks(
          split(values.tasks).length ? split(values.tasks) : [DEFAULT_TASKS_DIR],
        ))
          io.out(
            `${t.id}\t${t.size}\t${t.tiers.join(',')}\t${t.turns.length} turn(s)\t${t.description}`,
          )
        return 0
      }
      default:
        io.err(USAGE)
        return cmd === undefined || cmd === '--help' || cmd === 'help' ? 0 : 2
    }
  } catch (e) {
    io.err(`hafiz-harness: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

async function runCommand(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      tasks: { type: 'string' },
      only: { type: 'string' },
      model: { type: 'string', multiple: true },
      repeat: { type: 'string' },
      'kilo-bin': { type: 'string' },
      out: { type: 'string' },
      shaper: { type: 'string' },
      mock: { type: 'boolean' },
      keep: { type: 'boolean' },
      isolate: { type: 'boolean' },
      'turn-timeout': { type: 'string' },
      tier: { type: 'string' },
      'fail-fast': { type: 'boolean' },
      'no-fail-fast': { type: 'boolean' },
    },
  })
  if (values.tier !== undefined && !(TIERS as readonly string[]).includes(values.tier))
    throw new Error(`--tier takes ${TIERS.join(' or ')}`)
  if (values['fail-fast'] && values['no-fail-fast'])
    throw new Error('pass --fail-fast or --no-fail-fast, not both')
  const tier = (values.tier ?? 'smoke') as Tier
  const failFast = values['no-fail-fast'] ? false : (values['fail-fast'] ?? tier === 'smoke')
  const mock = !!values.mock
  const models = mock ? [MOCK_MODEL] : (values.model ?? [])
  if (!models.length) throw new Error('pass --model provider/model (or --mock)')
  for (const m of models)
    if (!mock && !m.includes('/')) throw new Error(`model '${m}' must be provider/model`)
  let repeat = Math.max(1, Number(values.repeat ?? 1) || 1)
  if (tier === 'smoke' && repeat > 1) {
    io.err('hafiz-harness: --tier smoke runs each task once; pass --tier full to repeat')
    repeat = 1
  }
  // --only picks from every task unless a tier was asked for explicitly
  const only = split(values.only)
  const tasks = loadTasks(
    split(values.tasks).length ? split(values.tasks) : [DEFAULT_TASKS_DIR],
    only,
    only.length && values.tier === undefined ? undefined : tier,
  )
  const timeout = values['turn-timeout'] === undefined ? undefined : Number(values['turn-timeout'])
  if (timeout !== undefined && !(timeout > 0)) throw new Error('--turn-timeout takes seconds > 0')
  const kiloBin = resolveKilo(values['kilo-bin'])
  const out = resolve(values.out ?? 'harness-results')
  mkdirSync(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let failed = false
  for (const model of models) {
    const runDir = join(out, `${slug(model)}-${stamp}`)
    const results: RunResult[] = []
    for (const task of tasks)
      for (let n = 1; n <= repeat; n++) {
        const r = await runTask(task, n, {
          failFast,
          model,
          mock,
          kiloBin,
          outDir: runDir,
          shaper: values.shaper,
          keep: values.keep,
          isolate: values.isolate,
          ...(timeout ? { turnTimeoutMs: timeout * 1000 } : {}),
          log: (l) => io.err(l),
        })
        results.push(r)
        io.err(
          `${task.id}#${n}: ${r.passed ? 'passed' : `FAILED${r.error ? ` (${r.error})` : ''}`}`,
        )
        // fail-fast: a task that missed a per-turn check is not repeated
        if (r.stopped) {
          if (n < repeat) io.err(`${task.id}: fail-fast, skipping ${repeat - n} more repeat(s)`)
          break
        }
      }
    const report = buildReport(results, { model, mock })
    const md = renderMarkdown(report)
    writeFileSync(join(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    writeFileSync(join(runDir, 'report.md'), md)
    io.out(md)
    io.err(`results: ${runDir}/report.json`)
    if (results.some((r) => !r.passed)) failed = true
  }
  return failed ? 1 : 0
}
