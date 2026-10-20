// Pieces every command module needs: the IO seam and opening the store with its layered config.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Actor,
  CliError,
  type Config,
  Core,
  configDirs,
  loadConfig,
  type Notice,
  osUser,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import { createBackend, type DaemonClient, STORAGE_BACKENDS } from '@hafiz/gateway-mcp'
import { stringify } from 'yaml'

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
  const { storeDir, repoRoot } = resolveProject(io.cwd, io.env)
  return openAndRun(storeDir, io.env, fn, repoRoot)
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

/** Select the storage backend for a store through its own config layer (`config/hafiz.yaml`). */
export function writeStoreBackend(storeDir: string, backend: string) {
  if (!STORAGE_BACKENDS.includes(backend as 'fs'))
    throw new CliError(`--backend must be one of ${STORAGE_BACKENDS.join(', ')}`)
  mkdirSync(join(storeDir, 'config'), { recursive: true })
  writeFileSync(join(storeDir, 'config', 'hafiz.yaml'), stringify({ storage: { backend } }))
}
