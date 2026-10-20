// Pieces every command module needs: the IO seam and opening the store with its layered config.
import {
  type Actor,
  type Config,
  Core,
  configDirs,
  loadConfig,
  type Notice,
  osUser,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import { createBackend, type DaemonClient } from '@hafiz/gateway-mcp'

export { writeStoreBackend } from '@hafiz/gateway-mcp'

export interface Io {
  cwd: string
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
  /** Path of this CLI's entry script, used to spawn a detached `hafiz daemon`. */
  entry?: string
  /** Replace daemon discovery (tests run the daemon in-process). */
  connect?: (project: ResolvedProject) => Promise<DaemonClient>
}

export function userActor(): Actor {
  return { sessionId: 'cli', role: 'user', agent: osUser() }
}

export function projectConfig(storeDir: string, env: NodeJS.ProcessEnv): Config {
  return loadConfig(configDirs(storeDir, env))
}

export async function withCore<T>(
  io: Io,
  fn: (core: Core, storeDir: string) => Promise<T>,
): Promise<T> {
  // Git operations (HEAD at done) run in the caller's own working tree.
  const { storeDir, worktree } = resolveProject(io.cwd, io.env)
  return openAndRun(storeDir, io.env, fn, worktree)
}

export async function openAndRun<T>(
  storeDir: string,
  env: NodeJS.ProcessEnv,
  fn: (core: Core, storeDir: string) => Promise<T>,
  repoDir?: string,
): Promise<T> {
  const config = projectConfig(storeDir, env)
  const backend = createBackend(config, storeDir, { minorBatchSeconds: 0 })
  await backend.open()
  try {
    return await fn(new Core({ config, backend, env, ...(repoDir ? { repoDir } : {}) }), storeDir)
  } finally {
    await backend.close()
  }
}

export function printNotices(io: Io, notices: Notice[]) {
  for (const n of notices) io.err(`${n.level}: ${n.text}`)
}
