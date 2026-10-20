// One task run: temp workdir + toy repo + `hafiz init` + optional seed, a daemon the harness owns
// (so it can read the store afterwards), then one `kilo run` per user turn, then the metrics.
// Real mode reuses the owner's own Kilo auth/config (their HOME); --mock replaces the provider
// with the scripted mock LLM and a throwaway HOME.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as hafiz, type Io } from '@hafiz/cli'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { writeFixture } from './fixture.js'
import { collectMetrics, type RunMetrics } from './metrics.js'
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
  turnTimeoutMs?: number | undefined
  /** Milliseconds to wait after the last turn for report capture and session-end checks. */
  settleMs?: number | undefined
  log?: ((line: string) => void) | undefined
}

export interface TurnResult {
  agent: string
  code: number
  ms: number
}

export interface RunResult {
  task: string
  size: string
  repeat: number
  model: string
  mock: boolean
  /** Every turn exited 0 and every expectation holds. */
  passed: boolean
  turns: TurnResult[]
  wallMs: number
  metrics: RunMetrics
  expectations: Expectation[]
  llmRequests?: number
  error?: string
  workdir?: string
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

function kiloTurn(a: {
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
    })
    let stdout = ''
    let stderr = ''
    p.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    p.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    const timer = setTimeout(() => p.kill('SIGKILL'), a.timeoutMs)
    p.on('error', (e) => {
      clearTimeout(timer)
      rej(e)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      writeFileSync(`${a.logBase}.out.jsonl`, stdout)
      writeFileSync(`${a.logBase}.err.log`, stderr)
      res({ code: code ?? -1, stdout, ms: Date.now() - t0 })
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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAFIZ_STORE_ROOT: join(work, 'stores'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
    KILO_DISABLE_SHARE: '1',
    KILO_DISABLE_SESSION_INGEST: '1',
  }
  if (opts.mock) {
    const home = join(work, 'home')
    mkdirSync(join(home, '.config'), { recursive: true })
    Object.assign(env, { HOME: home, KILO_DISABLE_MODELS_FETCH: '1' })
  }

  let daemon: DaemonHandle | undefined
  let mock: MockLlm | undefined
  const turns: TurnResult[] = []
  const t0 = Date.now()
  let error: string | undefined
  let metrics: RunMetrics = { total: {}, roles: {} }
  try {
    const io: Io = { cwd: repo, env, out: () => undefined, err: (l) => log(l) }
    if ((await hafiz(['init', task.setup.project_name], io)) !== 0)
      throw new Error('hafiz init failed')
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
        timeoutMs: opts.turnTimeoutMs ?? (opts.mock ? 120_000 : 900_000),
        logBase: join(runDir, `turn-${i + 1}`),
      })
      turns.push({ agent, code: r.code, ms: r.ms })
      session ??= sessionIdOf(r.stdout)
      if (r.code !== 0) {
        error = `turn ${i + 1} exited ${r.code} (see ${runDir}/turn-${i + 1}.err.log)`
        break
      }
    }
    await sleep(opts.settleMs ?? 3000)
    metrics = await collectMetrics(daemon.service.core.backend.read)
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
    wallMs: Date.now() - t0,
    metrics,
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
