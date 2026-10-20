// Start tracking a repo: create a store and write the pointer into git's common dir. Shared by
// `hafiz init` and the Kilo plugin's `hafiz_track_project` tool, so both do exactly the same.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  type Actor,
  CliError,
  type Config,
  Core,
  configDirs,
  defaultStoreRoot,
  gitPointerFile,
  loadConfig,
  type Notice,
  opaqueId,
  originFingerprint,
  osUser,
  POINTER_PATH,
  type Pointer,
  readPointer,
  repoRootOf,
} from '@hafiz/core'
import { stringify } from 'yaml'
import { createBackend, STORAGE_BACKENDS } from './backend.js'

export interface InitProjectOptions {
  /** Any directory inside the repo. */
  cwd: string
  name: string
  env?: NodeJS.ProcessEnv
  /** Store root (default `$HAFIZ_STORE_ROOT` or ~/.hafiz/projects), relative to `cwd`. */
  storeRoot?: string | undefined
  /** Re-point a repo whose pointer names a store that no longer exists. */
  adopt?: boolean | undefined
  /** Storage backend written to the store's own config layer. */
  backend?: string | undefined
  /** Who creates the project (git author of the first commit); default the OS user. */
  by?: Actor
}

export interface InitProjectResult {
  id: string
  name: string
  storeDir: string
  pointerFile: string
  rootBlockId: string
  /** The repo already had code: the project starts with `onboarding: pending`. */
  onboarding: boolean
  notices: Notice[]
}

/** Select the storage backend for a store through its own config layer (`config/hafiz.yaml`). */
export function writeStoreBackend(storeDir: string, backend: string) {
  if (!STORAGE_BACKENDS.includes(backend as 'fs'))
    throw new CliError(`--backend must be one of ${STORAGE_BACKENDS.join(', ')}`)
  mkdirSync(join(storeDir, 'config'), { recursive: true })
  writeFileSync(join(storeDir, 'config', 'hafiz.yaml'), stringify({ storage: { backend } }))
}

/** Docs, licences and dotfiles: tracked files that do not make a repo "have code". */
const NOT_SOURCE =
  /(^|\/)\.[^/]*$|\.(md|markdown|txt|rst|adoc)$|(^|\/)(readme|license|licence|copying|changelog|contributing|code_of_conduct|authors|notice)(\.[^/]*)?$/i

/**
 * Brownfield heuristic: the repo has commits and at least `onboarding.min_source_files` tracked
 * source files. Greenfield repos (empty, or a README and a licence) get no onboarding.
 */
export function hasExistingCode(worktree: string, config: Config): boolean {
  const run = (args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd: worktree,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      })
    } catch {
      return null
    }
  }
  if (!run(['rev-parse', '--verify', '-q', 'HEAD'])) return false
  const files = (run(['ls-files', '-z']) ?? '').split('\0').filter(Boolean)
  const min = config.hafiz.onboarding.min_source_files
  let n = 0
  for (const f of files) if (!NOT_SOURCE.test(f) && ++n >= min) return true
  return min === 0
}

/** Create the store and the git-dir pointer for the repo containing `opts.cwd`. */
export async function initProject(opts: InitProjectOptions): Promise<InitProjectResult> {
  const env = opts.env ?? process.env
  const worktree = repoRootOf(opts.cwd) // refuses outside git
  const pointerFile = gitPointerFile(opts.cwd)
  const legacy = join(worktree, POINTER_PATH)
  if (existsSync(legacy) && !existsSync(pointerFile))
    throw new CliError(
      `this repo already has a legacy pointer (${legacy}); run \`hafiz migrate-pointer\` to move it into the git dir`,
    )
  if (existsSync(pointerFile)) {
    const existing = readPointer(pointerFile)
    const store = env.HAFIZ_STORE_ROOT ? join(env.HAFIZ_STORE_ROOT, existing.id) : existing.store
    if (existsSync(store)) throw new CliError(`already initialised (store ${store})`)
    if (!opts.adopt)
      throw new CliError(
        `this repo points at a store that no longer exists (${store}); ` +
          'run `hafiz init --adopt <name>` to create a fresh store and re-point the repo',
      )
  }
  const root = resolve(opts.cwd, opts.storeRoot ?? defaultStoreRoot(env))
  const id = opaqueId('prj', 4)
  const storeDir = join(root, id)
  const fingerprint = originFingerprint(worktree)
  // The store's own config layer selects the backend (hafiz.yaml storage.backend).
  if (opts.backend) writeStoreBackend(storeDir, opts.backend)
  const config = loadConfig(configDirs(storeDir, env))
  const onboarding = hasExistingCode(worktree, config)
  const backend = createBackend(config, storeDir, { minorBatchSeconds: 0 })
  await backend.open()
  let rootBlockId: string
  let notices: Notice[]
  try {
    const core = new Core({ config, backend, env, repoDir: worktree })
    const by: Actor = opts.by ?? { sessionId: 'cli', role: 'user', agent: osUser() }
    const r = await core.projectInit(by, {
      name: opts.name,
      originFingerprint: fingerprint,
      id,
      ...(onboarding ? { onboarding } : {}),
    })
    rootBlockId = r.result.root.id
    notices = r.notices
  } finally {
    await backend.close()
  }
  const pointer: Pointer = { id, fingerprint, store: storeDir }
  mkdirSync(dirname(pointerFile), { recursive: true })
  writeFileSync(pointerFile, stringify(pointer))
  return {
    id,
    name: opts.name,
    storeDir,
    pointerFile,
    rootBlockId,
    onboarding,
    notices,
  }
}
