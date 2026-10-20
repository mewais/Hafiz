// Project resolution: repo pointer -> store directory. Shared by CLI, daemon, MCP and the plugin.
//
// Two separate questions, answered from two places:
// - project identity (which store) comes from the pointer in git's *common* dir
//   (`$(git rev-parse --git-common-dir)/hafiz/project.yaml`), which the main checkout and every
//   `git worktree` share, so all worktrees resolve to one project, one store and one daemon;
// - the working tree (HEAD at `done`, drift) is the caller's own `--show-toplevel`.
// A legacy `<repo>/.hafiz/project.yaml` (found walking up) still resolves; `hafiz migrate-pointer`
// moves it into the git dir.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse } from 'yaml'

export interface Pointer {
  id: string
  fingerprint: string
  store: string
}

export interface ResolvedProject {
  /**
   * Top level of the caller's working tree (the main checkout or a linked worktree): the
   * directory git operations for this caller run in. For a legacy pointer outside git, the
   * directory holding `.hafiz/`.
   */
  worktree: string
  pointerFile: string
  /** True when the pointer is the legacy `<repo>/.hafiz/project.yaml`. */
  legacy: boolean
  pointer: Pointer
  storeDir: string
}

/** Legacy pointer, relative to the repo root. */
export const POINTER_PATH = join('.hafiz', 'project.yaml')
/** Pointer relative to git's common dir. */
export const GIT_POINTER_PATH = join('hafiz', 'project.yaml')

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

/** `dir`, or its nearest existing ancestor (git needs a real cwd). */
function existingDir(dir: string): string {
  let d = resolve(dir)
  for (;;) {
    try {
      if (statSync(d).isDirectory()) return d
    } catch {}
    const up = dirname(d)
    if (up === d) return d
    d = up
  }
}

/** The repo's current HEAD commit, or undefined when `dir` is not a git repo with commits. */
export function gitHead(dir: string): string | undefined {
  return git(dir, ['rev-parse', 'HEAD']) || undefined
}

/** Absolute git common dir (shared by all worktrees) for `cwd`, or null outside git. */
export function gitCommonDir(cwd: string): string | null {
  const dir = existingDir(cwd)
  const d = git(dir, ['rev-parse', '--git-common-dir'])
  return d ? resolve(dir, d) : null
}

/** Absolute top level of the working tree containing `cwd`, or null outside git. */
export function worktreeOf(cwd: string): string | null {
  const top = git(existingDir(cwd), ['rev-parse', '--show-toplevel'])
  return top ? resolve(top) : null
}

/** Absolute top level of the working tree containing `cwd`; throws outside git. */
export function repoRootOf(cwd: string): string {
  const top = worktreeOf(cwd)
  if (!top) throw new CliError(`${cwd} is not inside a git repository`)
  return top
}

/** Where the pointer for the repo containing `cwd` lives; throws outside git. */
export function gitPointerFile(cwd: string): string {
  const common = gitCommonDir(cwd)
  if (!common) throw new CliError(`${cwd} is not inside a git repository`)
  return join(common, GIT_POINTER_PATH)
}

/**
 * sha256(origin URL, else the repo's location) + ':' + OS username, 16 hex chars. The location
 * is the common dir's checkout (`<main checkout>` for `<main checkout>/.git`, the common dir
 * itself for a bare repo), so every worktree yields the same value and pre-worktree pointers
 * stay valid. Separate clones of one remote get the same fingerprint but separate projects.
 */
export function originFingerprint(dir: string): string {
  const common = gitCommonDir(dir)
  const where = common ? (basename(common) === '.git' ? dirname(common) : common) : resolve(dir)
  const origin = (common && git(dir, ['remote', 'get-url', 'origin'])) || where
  return createHash('sha256').update(`${origin}:${osUser()}`).digest('hex').slice(0, 16)
}

export function readPointer(file: string): Pointer {
  const p = parse(readFileSync(file, 'utf8')) as Partial<Pointer> | null
  if (!p?.id || !p.fingerprint || !p.store) throw new CliError(`malformed pointer file ${file}`)
  return { id: p.id, fingerprint: p.fingerprint, store: p.store }
}

/** Walk up from `cwd` looking for a legacy `.hafiz/project.yaml`. */
export function findLegacyPointerFile(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    const f = join(dir, POINTER_PATH)
    if (existsSync(f)) return f
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** The pointer for `cwd`: git common dir first, then a legacy `.hafiz/project.yaml` walking up. */
export function findPointerFile(cwd: string): string | null {
  const common = gitCommonDir(cwd)
  if (common) {
    const f = join(common, GIT_POINTER_PATH)
    if (existsSync(f)) return f
  }
  return findLegacyPointerFile(cwd)
}

export function resolveProject(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedProject {
  const pointerFile = findPointerFile(cwd)
  if (!pointerFile) throw new CliError('no Hafiz project here; run `hafiz init <name>` first')
  const pointer = readPointer(pointerFile)
  const legacy = pointerFile.endsWith(POINTER_PATH)
  const worktree = worktreeOf(cwd) ?? dirname(dirname(pointerFile))
  // The pointer records an absolute store path; HAFIZ_STORE_ROOT re-roots it (tests, relocated stores).
  const storeDir = env.HAFIZ_STORE_ROOT ? join(env.HAFIZ_STORE_ROOT, pointer.id) : pointer.store
  if (!existsSync(storeDir))
    throw new CliError(
      `store ${storeDir} is missing; run \`hafiz init --adopt <name>\` to start a fresh store`,
    )
  return { worktree, pointerFile, legacy, pointer, storeDir }
}
