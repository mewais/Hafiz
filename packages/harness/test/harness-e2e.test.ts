// The whole harness against real Kilo, with the scripted mock LLM instead of a model: setup,
// seeding, per-turn `kilo run`, metric collection and scoring must come out as scripted.
// Slow; needs the Kilo CLI: HAFIZ_KILO_E2E=1 HAFIZ_KILO_BIN=<path to the kilo binary>
// (`npm i @kilocode/cli` puts it at node_modules/@kilocode/cli-linux-x64/bin/kilo).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { type RunResult, runTask } from '../src/runner.js'
import { loadTasks } from '../src/tasks.js'

const BIN = process.env.HAFIZ_KILO_BIN
const enabled = process.env.HAFIZ_KILO_E2E === '1' && !!BIN

describe.skipIf(!enabled)('harness, mock mode, real Kilo (HAFIZ_KILO_E2E=1)', () => {
  const out = realpathSync(mkdtempSync(join(tmpdir(), 'hafiz-harness-out-')))
  afterAll(() => rmSync(out, { recursive: true, force: true }))
  const ids = { S: 's-small-fix', M: 'm-feature', L: 'l-seeded-tree' }
  const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]))

  const run = (size: 'S' | 'M' | 'L', keep = false): Promise<RunResult> =>
    runTask(tasks[ids[size]] as NonNullable<(typeof tasks)[string]>, 1, {
      mock: true,
      kiloBin: BIN as string,
      outDir: out,
      keep,
    })

  it('S: a one-off fix leaves no Hafiz trace', async () => {
    const r = await run('S', true)
    if (!r.passed) console.error(JSON.stringify(r.expectations.filter((e) => !e.pass)), r.error)
    expect(r.passed).toBe(true)
    expect(r.metrics.total).toMatchObject({
      hafiz_writes: 0,
      tracked: 0,
      files_written: 1,
      sessions: 1,
    })
    // the scripted edit really fixed the toy repo
    const repo = join(r.workdir as string, 'repo')
    expect(readFileSync(join(repo, 'src/money.ts'), 'utf8')).toContain("padStart(2, '0')")
    execFileSync('npm', ['test'], {
      cwd: repo,
      stdio: 'ignore',
    })
    rmSync(r.workdir as string, { recursive: true, force: true })
  }, 150000)

  it('M: a feature becomes a block with four children and a worker each', async () => {
    const r = await run('M')
    if (!r.passed) console.error(JSON.stringify(r.expectations.filter((e) => !e.pass)), r.error)
    expect(r.passed).toBe(true)
    expect(r.metrics.total).toMatchObject({
      tracked: 1, // the scripted manager called hafiz_track_project; the harness never ran init
      blocks_created: 5,
      decisions: 1,
      done_requests: 4,
      done_with_digest: 4,
      reports: 4,
      cap_rejections: 0,
    })
    expect(r.metrics.roles.worker).toMatchObject({
      sessions: 4,
      progress: 8, // exactly the scripted 2 per worker
      steps: 8,
      progress_min: 2,
      files_written_managed: 4,
    })
    expect(r.metrics.total.view_emits).toBeGreaterThan(0)
    expect(r.metrics.total.cache_read_ratio).toBeGreaterThan(0)
    expect(r.llmRequests).toBeGreaterThan(10)
    expect(existsSync(join(out, 'm-feature-1', 'result.json'))).toBe(true)
    // every delegation as the model wrote it, none refused
    const sent = readFileSync(join(out, 'm-feature-1', 'delegations.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(sent).toHaveLength(4)
    expect(sent[0]).toMatchObject({ role: 'manager', agent: 'worker' })
    expect(sent[0].block).toBeTruthy()
    expect(r.rejected).toEqual([])
    expect(r.metrics.total.spawns_rejected).toBe(0)
    expect(r.filesChanged).toHaveLength(4)
  }, 150000)

  it('L: seeded tree, designer + planner + three workers, a standing decision, a parked thread', async () => {
    const r = await run('L')
    if (!r.passed) console.error(JSON.stringify(r.expectations.filter((e) => !e.pass)), r.error)
    expect(r.passed).toBe(true)
    expect(r.turns).toHaveLength(3)
    expect(r.metrics.total).toMatchObject({
      sessions: 7,
      decisions_standing: 1,
      threads_opened: 1,
      threads_parked: 1,
      threads_open_at_end: 0,
      done_requests: 3,
    })
    expect(r.metrics.roles.designer).toMatchObject({ docs_written: 2 })
    expect(r.metrics.roles.planner).toMatchObject({ docs_written: 2 })
  }, 300000)
})
