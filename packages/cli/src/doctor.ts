// `hafiz doctor`: a compact health report. Exit code 1 when any check fails.
import { execFileSync } from 'node:child_process'
import {
  type Block,
  type Core,
  checkDocs,
  type Doc,
  normalizeSchemaVersion,
  originFingerprint,
  type Ref,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import { DaemonClient, pidAlive, readLock, socketPathFor } from '@hafiz/gateway-mcp'
import { kiloInstalledIn } from './install-host.js'
import { CliError } from './resolve.js'
import { type Io, withCore } from './shared.js'

type Level = 'ok' | 'warn' | 'fail' | 'skip'
export interface Check {
  name: string
  level: Level
  detail: string
  items?: string[]
}

const MARK: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: '-   ' }

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Refs in a digest's `pointers` that can name files: not URLs, PR numbers or bare commits. */
export function pointerPaths(refs: readonly Ref[]): string[] {
  const out = new Set<string>()
  for (const r of refs) {
    const ref = String(r.ref ?? '')
      .trim()
      .replace(/(:\d+(-\d+)?|#L\d+(-L\d+)?)$/, '')
    if (!ref || /\s/.test(ref) || ref.startsWith('#') || /^[a-z]+:\/\//.test(ref)) continue
    if (/^[0-9a-f]{7,40}$/.test(ref) || /^[\w.-]+\/[\w.-]+(#|\/pull\/)\d*$/.test(ref)) continue
    if (/^github\.com\//.test(ref)) continue
    out.add(ref)
  }
  return [...out]
}

export function checkPointer(project: ResolvedProject, stored: { id: string; fp: string }): Check {
  const { pointer } = project
  const problems: string[] = []
  if (pointer.id !== stored.id) problems.push(`pointer id ${pointer.id} != store ${stored.id}`)
  if (pointer.fingerprint !== stored.fp)
    problems.push(`pointer fingerprint ${pointer.fingerprint} != store ${stored.fp}`)
  if (problems.length)
    return {
      name: 'pointer',
      level: 'fail',
      detail: `${problems.join('; ')}; this repo may point at another project's store`,
    }
  const here = originFingerprint(project.repoRoot)
  if (here !== pointer.fingerprint)
    return {
      name: 'pointer',
      level: 'warn',
      detail: `matches the store, but this checkout's origin fingerprint is ${here} (remote or user changed)`,
    }
  return { name: 'pointer', level: 'ok', detail: `${pointer.id} matches the store fingerprint` }
}

async function checkDaemon(project: ResolvedProject, env: NodeJS.ProcessEnv): Promise<Check> {
  const lock = readLock(project.storeDir)
  if (!lock) return { name: 'daemon', level: 'ok', detail: 'not running (starts on demand)' }
  if (!pidAlive(lock.pid))
    return {
      name: 'daemon',
      level: 'warn',
      detail: `stale lock from dead pid ${lock.pid}; the next client reclaims it`,
    }
  const socket = lock.socket || socketPathFor(project.pointer.id, env)
  try {
    const c = await Promise.race([
      DaemonClient.connect(socket),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 2000)),
    ])
    c.close()
    return { name: 'daemon', level: 'ok', detail: `pid ${lock.pid} answers on ${socket}` }
  } catch (e) {
    return {
      name: 'daemon',
      level: 'fail',
      detail: `pid ${lock.pid} holds the lock but ${socket} does not answer (${(e as Error).message})`,
    }
  }
}

export function driftChecks(
  repoRoot: string,
  blocks: readonly Block[],
  docs: readonly Doc[],
): Check {
  if (git(repoRoot, ['rev-parse', 'HEAD']) === null)
    return { name: 'drift', level: 'skip', detail: 'repo has no commits to compare against' }
  const done = blocks.filter((b) => b.status === 'done')
  const tracked = done.filter((b) => b.doneAt?.commit)
  const items: string[] = []
  for (const b of tracked) {
    const digest = docs.find((d) => d.blockId === b.id && d.type === 'digest')
    const refs = digest?.sections.pointers
    const paths = Array.isArray(refs) ? pointerPaths(refs as Ref[]) : []
    if (!paths.length) continue
    const commit = b.doneAt?.commit as string
    const changed = git(repoRoot, ['diff', '--name-only', `${commit}..HEAD`, '--', ...paths])
    if (changed === null) {
      items.push(`${b.id}: done at ${commit.slice(0, 8)}, which is not in this repo's history`)
      continue
    }
    const files = changed.split('\n').filter(Boolean)
    if (files.length) items.push(`${b.id}: ${files.join(', ')} changed since ${commit.slice(0, 8)}`)
  }
  const untracked = done.length - tracked.length
  const note = untracked ? ` (${untracked} done block(s) predate commit tracking)` : ''
  if (items.length)
    return {
      name: 'drift',
      level: 'warn',
      detail: `${items.length} done block(s) have changed files${note}`,
      items,
    }
  return {
    name: 'drift',
    level: 'ok',
    detail: `${tracked.length} done block(s) checked, no drift${note}`,
  }
}

async function checkCondenser(core: Core, online: boolean): Promise<Check> {
  const llm = core.config.hafiz.llm.condenser
  if (llm.provider === 'none')
    return { name: 'condenser', level: 'skip', detail: 'not configured (host compaction stays on)' }
  if (llm.provider === 'kilo')
    return {
      name: 'condenser',
      level: 'ok',
      detail: `kilo ${llm.model}: runs inside Kilo through the Kilo plugin (no key needed)`,
    }
  if (!online)
    return {
      name: 'condenser',
      level: 'skip',
      detail: `${llm.provider}/${llm.model} (run with --online to test reachability)`,
    }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), (llm.timeout_seconds ?? 20) * 1000)
    try {
      await core.condenserProvider.complete(
        { system: 'Reply with the single word ok.', prompt: 'ping', maxTokens: 8 },
        ctl.signal,
      )
    } finally {
      clearTimeout(timer)
    }
    return { name: 'condenser', level: 'ok', detail: `${llm.provider}/${llm.model} answered` }
  } catch (e) {
    return {
      name: 'condenser',
      level: 'fail',
      detail: `${llm.provider}/${llm.model} unreachable: ${(e as Error).message}`,
    }
  }
}

export async function doctor(
  io: Io,
  opts: { online?: boolean | undefined; json?: boolean | undefined },
): Promise<number> {
  const checks: Check[] = []
  let project: ResolvedProject
  try {
    project = resolveProject(io.cwd, io.env)
  } catch (e) {
    checks.push({
      name: 'pointer',
      level: 'fail',
      detail: e instanceof CliError ? e.message : String(e),
    })
    return report(io, checks, opts.json)
  }
  const daemon = await checkDaemon(project, io.env)

  try {
    await withCore(io, async (core) => {
      const stored = await core.backend.read.getProject()
      if (!stored) {
        checks.push({ name: 'pointer', level: 'fail', detail: 'the store has no project' })
        return
      }
      checks.push(checkPointer(project, { id: stored.id, fp: stored.originFingerprint }), daemon)

      const dirty = await core.backend.dirty()
      const live = readLock(project.storeDir)
      checks.push(
        live && pidAlive(live.pid)
          ? {
              name: 'store',
              level: 'skip',
              detail: 'dirty check skipped while the daemon batches writes',
            }
          : dirty.length
            ? {
                name: 'store',
                level: 'warn',
                detail: `${dirty.length} file(s) edited outside Hafiz; the next write commits them`,
                items: dirty,
              }
            : { name: 'store', level: 'ok', detail: `clean (${core.backend.name} backend)` },
      )

      const { blocks, docs } = await core.allDocs()
      const pinned = normalizeSchemaVersion(stored.schemaSetVersion)
      const want = core.config.hafiz.schema_version
      const problems = checkDocs(core.config, core.tok, blocks, docs)
      if (pinned !== want)
        checks.push({
          name: 'schema',
          level: 'fail',
          detail: `project pins schema set ${pinned}, the loaded set is ${want}; run \`hafiz migrate\``,
          items: problems.map((p) => `${p.block} ${p.type}: ${p.problem}`),
        })
      else if (problems.length)
        checks.push({
          name: 'schema',
          level: 'fail',
          detail: `${problems.length} doc(s) fail schema set ${want}`,
          items: problems.map((p) => `${p.block} ${p.type}: ${p.problem}`),
        })
      else
        checks.push({
          name: 'schema',
          level: 'ok',
          detail: `${docs.length} doc(s) satisfy schema set ${want}`,
        })

      checks.push(driftChecks(project.repoRoot, blocks, docs))
      checks.push(await checkCondenser(core, !!opts.online))
    })
  } catch (e) {
    checks.push({
      name: 'store',
      level: 'fail',
      detail: `cannot open ${project.storeDir}: ${(e as Error).message}`,
    })
    if (!checks.some((c) => c.name === 'daemon')) checks.push(daemon)
  }

  const kilo = kiloInstalledIn(io)
  checks.push(
    kilo.length
      ? { name: 'kilo', level: 'ok', detail: `plugin listed in ${kilo.join(', ')}` }
      : {
          name: 'kilo',
          level: 'warn',
          detail: 'plugin not found in Kilo config; run `hafiz install kilo`',
        },
  )
  return report(io, checks, opts.json)
}

function report(io: Io, checks: Check[], json?: boolean | undefined): number {
  const failed = checks.some((c) => c.level === 'fail')
  if (json) io.out(JSON.stringify({ ok: !failed, checks }, null, 2))
  else {
    for (const c of checks) {
      io.out(`${MARK[c.level]} ${c.name.padEnd(9)} ${c.detail}`)
      for (const i of c.items ?? []) io.out(`       ${i}`)
    }
    const warns = checks.filter((c) => c.level === 'warn').length
    io.out(
      failed ? 'doctor: problems found' : `doctor: healthy${warns ? ` (${warns} warning(s))` : ''}`,
    )
  }
  return failed ? 1 : 0
}
