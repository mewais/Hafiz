// One task run: temp workdir + toy repo + `hafiz init` + optional seed, a daemon the harness owns
// (so it can read the store afterwards), then one `kilo run` per user turn, then the metrics.
// Real mode reuses the owner's own Kilo auth/config (their HOME); --mock replaces the provider
// with the scripted mock LLM and a throwaway HOME.
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as hafiz, type Io } from '@hafiz/cli'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { stringify } from 'yaml'
import { writeFixture } from './fixture.js'
import { collectMetrics, type Delegation, type RunMetrics } from './metrics.js'
import { type MockLlm, startMockLlm } from './mock-llm.js'
import { scriptResponder, TURN_MARKER } from './mock-script.js'
import { type Expectation, scoreExpectations } from './score.js'
import { seedTree } from './seed.js'
import type { Task } from './tasks.js'

export interface RunOptions {
  /** `provider/model`; ignored in mock mode. */
  model?: string | undefined
  mock: boolean
  kiloBin: string
  /** Where per-run logs go (`<out>/<task>-<n>/`). */
  outDir: string
  /** Force the plugin's shaper (proxy | hooks | auto); default: the project's own setting. */
  shaper?: string | undefined
  /** Keep the temp workdir (repo, store) for inspection. */
  keep?: boolean | undefined
  /**
   * Run Kilo with an empty private config dir (XDG_CONFIG_HOME), so only the harness plugin (and
   * the agents it generates) is loaded: none of the owner's own plugins, agents or providers.
   */
  isolate?: boolean | undefined
  turnTimeoutMs?: number | undefined
  /** Milliseconds to wait after the last turn for report capture and session-end checks. */
  settleMs?: number | undefined
  log?: ((line: string) => void) | undefined
}

/** A review proposal the runner resolved between turns. */
export interface ReviewRecord {
  id: string
  kind: string
  block: string
  action: 'accept' | 'reject'
}

export interface TurnResult {
  agent: string
  code: number
  ms: number
}

/** Default per-turn limit for real models (seconds); `--turn-timeout` overrides it. */
export const TURN_TIMEOUT_S = 1800

export interface RunResult {
  task: string
  size: string
  repeat: number
  model: string
  mock: boolean
  /** Every turn exited 0 and every expectation holds. */
  passed: boolean
  turns: TurnResult[]
  /** Review proposals resolved as `user` between turns (task `review:`), in order. */
  reviews: ReviewRecord[]
  wallMs: number
  metrics: RunMetrics
  /** Files changed or added in the task repo against the seed commit. */
  filesChanged: string[]
  /** `task` calls the mechanical checks refused, with the error the model read. */
  rejected: Delegation[]
  expectations: Expectation[]
  llmRequests?: number
  error?: string
  workdir?: string
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n')
    .filter(Boolean)

/** Every delegation the plugin logged (`HAFIZ_DELEGATION_LOG`), in order. */
function readDelegations(file: string): Delegation[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Delegation)
}

/** The slice of a review-queue item the runner looks at. */
export interface ReviewQueueItem {
  id: string
  kind: string
  source?: string
  blockId?: string | undefined
}

/**
 * Resolve the pending design and plan reviews (`source === 'review'`) as the `user` role, through
 * the daemon. Done requests, drafts and compliance proposals are left alone (the manager audits
 * them). Rejections carry `note`, which reaches the manager.
 */
export async function resolveReviews(
  socketPath: string,
  action: 'accept' | 'reject',
  note?: string,
): Promise<ReviewRecord[]> {
  const user = await DaemonClient.connect(socketPath)
  try {
    await user.openSession({ id: 'harness-review', host: 'harness', role: 'user' })
    const done: ReviewRecord[] = []
    for (const p of (await user.reviewList()) as ReviewQueueItem[]) {
      if (p.source !== 'review' || (p.kind !== 'design' && p.kind !== 'plan')) continue
      if (action === 'accept') await user.reviewAccept(p.id)
      else await user.reviewReject(p.id, note)
      done.push({ id: p.id, kind: p.kind, block: p.blockId ?? '', action })
    }
    return done
  } finally {
    user.close()
  }
}

/** Write a task's `policies:` override into the (single) store under `storesRoot`. */
export function writePolicies(storesRoot: string, policies: Record<string, unknown>): void {
  const stores = readdirSync(storesRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
  const store = stores[0]
  if (stores.length !== 1 || !store) throw new Error(`expected one store in ${storesRoot}`)
  const dir = join(storesRoot, store.name, 'config')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'policies.yaml'), stringify(policies))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
export const MOCK_MODEL = 'mock/mock-model'

/** Kilo config overlay (KILO_CONFIG_CONTENT): our plugin on top of the owner's own config. */
export function kiloConfig(a: { plugin: string; shaper?: string | undefined; mock?: MockLlm }) {
  return {
    plugin: [[a.plugin, a.shaper ? { shaper: a.shaper } : {}]],
    autoupdate: false,
    share: 'disabled',
    ...(a.mock
      ? {
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Mock',
              options: { baseURL: `${a.mock.url}/v1`, apiKey: 'sk-test' },
              models: {
                'mock-model': {
                  name: 'Mock',
                  tool_call: true,
                  limit: { context: 100000, output: 4000 },
                },
              },
            },
          },
          small_model: MOCK_MODEL,
        }
      : {}),
  }
}

/** The plugin entry of the built @hafiz/host-kilo (a sibling package in this repo), as a file URL. */
export function pluginUrl(): string {
  const url = new URL('../../host-kilo/dist/index.js', import.meta.url)
  if (!existsSync(url)) throw new Error(`plugin not built (${fileURLToPath(url)}): run pnpm build`)
  return url.href
}

export function kiloTurn(a: {
  bin: string
  repo: string
  env: NodeJS.ProcessEnv
  config: unknown
  agent: string
  model: string
  prompt: string
  session?: string | undefined
  timeoutMs: number
  logBase: string
}): Promise<{ code: number; stdout: string; ms: number }> {
  const args = [
    'run',
    '--print-logs',
    '--log-level',
    'WARN',
    '--format',
    'json',
    '--auto',
    '--agent',
    a.agent,
    '-m',
    a.model,
    ...(a.session ? ['-s', a.session] : []),
    a.prompt,
  ]
  const t0 = Date.now()
  return new Promise((res, rej) => {
    const p = spawn(a.bin, args, {
      cwd: a.repo,
      // Kilo takes its directory from $PWD, not the process cwd
      env: { ...a.env, PWD: a.repo, KILO_CONFIG_CONTENT: JSON.stringify(a.config) },
      stdio: ['ignore', 'pipe', 'pipe'],
      // own process group, so a timeout kills Kilo's children too (they would hold the pipes open)
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    p.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    p.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    const kill = () => {
      timedOut = true
      try {
        if (p.pid) process.kill(-p.pid, 'SIGKILL')
      } catch {
        p.kill('SIGKILL')
      }
    }
    // Hard wall-clock limit from spawn, never reset by output. It compares Date.now() on a short
    // interval rather than trusting one long timer, which does not advance while the machine sleeps.
    const timer = setInterval(
      () => {
        if (Date.now() - t0 >= a.timeoutMs && !timedOut) kill()
      },
      Math.min(1000, Math.max(10, a.timeoutMs / 4)),
    )
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      writeFileSync(`${a.logBase}.out.jsonl`, stdout)
      writeFileSync(`${a.logBase}.err.log`, stderr)
      res({ code: timedOut ? -1 : (code ?? -1), stdout, ms: Date.now() - t0 })
    }
    p.on('error', (e) => {
      clearInterval(timer)
      rej(e)
    })
    p.on('close', finish)
    // after a timeout kill, do not wait for pipes that stray grandchildren may still hold open
    p.on('exit', (code) => {
      if (timedOut) finish(code)
    })
  })
}

/** The root session id out of `--format json` output. */
export function sessionIdOf(stdout: string): string | undefined {
  return /"sessionID"\s*:\s*"(ses_[A-Za-z0-9_-]+)"/.exec(stdout)?.[1]
}

export async function runTask(task: Task, repeat: number, opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? (() => undefined)
  const model = opts.mock ? MOCK_MODEL : (opts.model as string)
  const runDir = join(opts.outDir, `${task.id}-${repeat}`)
  mkdirSync(runDir, { recursive: true })
  const work = tmp(`hafiz-harness-${task.id}-`)
  const repo = join(work, 'repo')
  mkdirSync(repo)
  writeFixture(repo)
  const seedCommit = git(repo, 'rev-parse', 'HEAD')[0] as string
  const delegationLog = join(runDir, 'delegations.jsonl')
  rmSync(delegationLog, { force: true })

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAFIZ_STORE_ROOT: join(work, 'stores'),
    // private, empty: the user's ~/.hafiz/config (policies, rules) must not leak into a task
    HAFIZ_HOME: join(work, 'hafiz-home'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
    KILO_DISABLE_SHARE: '1',
    KILO_DISABLE_SESSION_INGEST: '1',
    HAFIZ_DELEGATION_LOG: delegationLog,
  }
  if (opts.mock) {
    const home = join(work, 'home')
    mkdirSync(join(home, '.config'), { recursive: true })
    Object.assign(env, { HOME: home, KILO_DISABLE_MODELS_FETCH: '1' })
  }
  if (opts.isolate) {
    // Kilo reads its global config (plugins, agents, providers) from $XDG_CONFIG_HOME/kilo;
    // auth stays where it is (XDG_DATA_HOME), so built-in providers still work.
    const xdg = join(work, 'kilo-config')
    mkdirSync(xdg, { recursive: true })
    env.XDG_CONFIG_HOME = xdg
  }

  let daemon: DaemonHandle | undefined
  let mock: MockLlm | undefined
  const turns: TurnResult[] = []
  const reviews: ReviewRecord[] = []
  const t0 = Date.now()
  let error: string | undefined
  let metrics: RunMetrics = { total: {}, roles: {} }
  let filesChanged: string[] = []
  let delegations: Delegation[] = []
  try {
    const io: Io = { cwd: repo, env, out: () => undefined, err: (l) => log(l) }
    if ((await hafiz(['init', task.setup.project_name], io)) !== 0)
      throw new Error('hafiz init failed')
    if (task.policies) writePolicies(env.HAFIZ_STORE_ROOT as string, task.policies)
    daemon = await startDaemon({ projectDir: repo, env, idleShutdownMs: 0 })
    // `{b.root}` and the seeded blocks' `as` names are available to mock scripts
    const vars: Record<string, string> = {}
    const user = await DaemonClient.connect(daemon.socketPath)
    try {
      await user.openSession({ id: 'harness-seed', host: 'harness', role: 'user' })
      const root = (await user.treeList())[0]?.id as string
      vars.root = root
      await seedTree(user, root, task.setup.seed, vars)
    } finally {
      user.close()
    }
    if (opts.mock) mock = await startMockLlm({ fallback: scriptResponder(task, { repo, vars }) })

    const config = kiloConfig({
      plugin: pluginUrl(),
      shaper: opts.shaper,
      ...(mock ? { mock } : {}),
    })
    let session: string | undefined
    for (const [i, turn] of task.turns.entries()) {
      const agent = turn.agent ?? task.agent
      const prompt = opts.mock ? `${turn.prompt}\n\n${TURN_MARKER(i + 1)}` : turn.prompt
      log(`${task.id}#${repeat} turn ${i + 1}/${task.turns.length} (${agent})`)
      const r = await kiloTurn({
        bin: opts.kiloBin,
        repo,
        env,
        config,
        agent,
        model,
        prompt,
        session,
        timeoutMs:
          (task.turn_timeout ? task.turn_timeout * 1000 : undefined) ??
          opts.turnTimeoutMs ??
          (opts.mock ? 120_000 : TURN_TIMEOUT_S * 1000),
        logBase: join(runDir, `turn-${i + 1}`),
      })
      turns.push({ agent, code: r.code, ms: r.ms })
      session ??= sessionIdOf(r.stdout)
      if (r.code !== 0) {
        const how =
          r.code === -1
            ? 'hit the harness timeout (SIGKILL), not a Kilo failure'
            : `exited ${r.code}`
        error = `turn ${i + 1} ${how} (see ${runDir}/turn-${i + 1}.err.log)`
        break
      }
      if (turn.review !== 'none')
        reviews.push(...(await resolveReviews(daemon.socketPath, turn.review, turn.note)))
    }
    await sleep(opts.settleMs ?? 3000)
    // What the run changed in the repo, whoever changed it (managed workers or not)
    filesChanged = [
      ...new Set([
        ...git(repo, 'diff', '--name-only', seedCommit),
        ...git(repo, 'ls-files', '--others', '--exclude-standard'),
      ]),
    ].sort()
    delegations = readDelegations(delegationLog)
    metrics = await collectMetrics(daemon.service.core.backend.read, { filesChanged, delegations })
  } catch (e) {
    error = String(e instanceof Error ? e.message : e)
  } finally {
    await mock?.close().catch(() => undefined)
    await daemon?.close().catch(() => undefined)
    if (!opts.keep) rmSync(work, { recursive: true, force: true })
  }
  const expectations = scoreExpectations(task.expect, metrics)
  const result: RunResult = {
    task: task.id,
    size: task.size,
    repeat,
    model,
    mock: opts.mock,
    passed: !error && turns.every((t) => t.code === 0) && expectations.every((x) => x.pass),
    turns,
    reviews,
    wallMs: Date.now() - t0,
    metrics,
    filesChanged,
    rejected: delegations.filter((d) => d.error),
    expectations,
    ...(mock ? { llmRequests: mock.requests.length } : {}),
    ...(error ? { error } : {}),
    ...(opts.keep ? { workdir: work } : {}),
  }
  writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** Resolve the kilo binary: --kilo-bin, $HAFIZ_KILO_BIN, else `kilo` on PATH (verified). */
export function resolveKilo(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  const bin = flag ?? env.HAFIZ_KILO_BIN ?? 'kilo'
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' })
  } catch {
    throw new Error(`cannot run '${bin}': pass --kilo-bin <path> or set HAFIZ_KILO_BIN`)
  }
  return bin
}
