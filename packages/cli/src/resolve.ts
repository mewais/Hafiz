// Project resolution: repo pointer (.hafiz/project.yaml) -> store directory. Reused by daemon/MCP.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

export interface Pointer {
  id: string
  fingerprint: string
  store: string
}

export interface ResolvedProject {
  /** Directory holding `.hafiz/project.yaml`. */
  repoRoot: string
  pointerFile: string
  pointer: Pointer
  storeDir: string
}

export const POINTER_PATH = join('.hafiz', 'project.yaml')

export class CliError extends Error {}

export function osUser(): string {
  return userInfo().username
}

export function defaultStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HAFIZ_STORE_ROOT || join(homedir(), '.hafiz', 'projects')
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/** Absolute root of the git repo containing `cwd`. */
export function repoRootOf(cwd: string): string {
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  if (!top) throw new CliError(`${cwd} is not inside a git repository`)
  return resolve(top)
}

/** sha256(origin URL, else absolute repo root) + ':' + OS username, 16 hex chars. */
export function originFingerprint(repoRoot: string): string {
  const origin = git(repoRoot, ['remote', 'get-url', 'origin']) || repoRoot
  return createHash('sha256').update(`${origin}:${osUser()}`).digest('hex').slice(0, 16)
}

export function readPointer(file: string): Pointer {
  const p = parse(readFileSync(file, 'utf8')) as Partial<Pointer> | null
  if (!p?.id || !p.fingerprint || !p.store) throw new CliError(`malformed pointer file ${file}`)
  return { id: p.id, fingerprint: p.fingerprint, store: p.store }
}

/** Walk up from `cwd` looking for `.hafiz/project.yaml`. */
export function findPointerFile(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    const f = join(dir, POINTER_PATH)
    if (existsSync(f)) return f
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

export function resolveProject(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedProject {
  const pointerFile = findPointerFile(cwd)
  if (!pointerFile) throw new CliError('no Hafiz project here; run `hafiz init <name>` first')
  const pointer = readPointer(pointerFile)
  const repoRoot = dirname(dirname(pointerFile))
  // The pointer records an absolute store path; HAFIZ_STORE_ROOT re-roots it (tests, relocated stores).
  const storeDir = env.HAFIZ_STORE_ROOT ? join(env.HAFIZ_STORE_ROOT, pointer.id) : pointer.store
  if (!existsSync(storeDir))
    throw new CliError(
      `store ${storeDir} is missing; run \`hafiz init --adopt <name>\` to start a fresh store`,
    )
  return { repoRoot, pointerFile, pointer, storeDir }
}
