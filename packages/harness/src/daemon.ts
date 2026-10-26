// The harness never starts the project's daemon for a Kilo run: the plugin does, through its own
// lookup-or-start path (project pointer -> socket under XDG_RUNTIME_DIR -> spawn `hafiz daemon`).
// These helpers let the runner act like a user of that daemon: find it the way the plugin and
// the CLI do, review through it, stop it at the end, and read the store once it is gone.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type Config,
  configDirs,
  loadConfig,
  type ReadOps,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import {
  createBackend,
  DaemonClient,
  ensureDaemon,
  pidAlive,
  readLock,
  socketPathFor,
} from '@hafiz/gateway-mcp'

/** The project of a repo, or undefined while the repo is not tracked (no pointer yet). */
export function projectOf(repo: string, env: NodeJS.ProcessEnv): ResolvedProject | undefined {
  try {
    return resolveProject(repo, env)
  } catch {
    return undefined
  }
}

/**
 * Where the plugin's daemon for `repo` listens: `socketPathFor(<pointer id>, env)`, the same
 * derivation `ensureDaemon` (plugin, CLI) uses. Undefined while the repo is untracked.
 */
export function pluginSocketPath(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const project = projectOf(repo, env)
  return project ? socketPathFor(project.pointer.id, env) : undefined
}

/** The hafiz CLI entry the plugin would spawn (`$HAFIZ_BIN`, else the workspace @hafiz/cli bin). */
function cliEntry(env: NodeJS.ProcessEnv): string | undefined {
  if (env.HAFIZ_BIN) return env.HAFIZ_BIN
  const url = new URL('../../cli/dist/bin.js', import.meta.url)
  return existsSync(url) ? fileURLToPath(url) : undefined
}

/**
 * The socket of the project's daemon, starting one only if none answers (what `hafiz review`
 * does for a person between two Kilo turns). Undefined while the repo is untracked.
 */
export async function userSocket(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const project = projectOf(repo, env)
  if (!project) return undefined
  const entry = cliEntry(env)
  const client = await ensureDaemon(project, { env, ...(entry ? { entry } : {}) })
  client.close()
  return socketPathFor(project.pointer.id, env)
}

/** The root block id of a tracked repo, over the running daemon; undefined when not reachable. */
export async function rootBlockOf(
  repo: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const socket = pluginSocketPath(repo, env)
  if (!socket) return undefined
  let client: DaemonClient | undefined
  try {
    client = await DaemonClient.connect(socket)
    await client.openSession({ id: 'harness-root', host: 'harness', role: 'user' })
    return (await client.treeList())[0]?.id
  } catch {
    return undefined
  } finally {
    client?.close()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Shut down the daemon serving the repo's store, whoever started it: SIGTERM to the pid in the
 * store lock (the `hafiz daemon` handler flushes and releases the lock), SIGKILL if it does not
 * exit in time. Resolves true if a daemon was running. No daemon, or no project: false.
 */
export async function stopDaemon(
  repo: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<boolean> {
  const project = projectOf(repo, env)
  const lock = project ? readLock(project.storeDir) : null
  if (!lock || !pidAlive(lock.pid)) return false
  try {
    process.kill(lock.pid, 'SIGTERM')
  } catch {
    return false
  }
  const deadline = Date.now() + timeoutMs
  while (pidAlive(lock.pid) && Date.now() < deadline) await sleep(50)
  if (pidAlive(lock.pid)) {
    try {
      process.kill(lock.pid, 'SIGKILL')
    } catch {}
    while (pidAlive(lock.pid) && Date.now() < deadline + 2000) await sleep(50)
  }
  return true
}

/** Open the repo's store directly (no daemon may be serving it) and run `fn` on its read side. */
export async function withStoreRead<T>(
  repo: string,
  env: NodeJS.ProcessEnv,
  fn: (read: ReadOps, config: Config) => Promise<T>,
): Promise<T | undefined> {
  const project = projectOf(repo, env)
  if (!project) return undefined
  const config = loadConfig(configDirs(project.storeDir, env))
  const backend = createBackend(config, project.storeDir)
  await backend.open()
  try {
    return await fn(backend.read, config)
  } finally {
    await backend.close()
  }
}
