// The runner finds the plugin's daemon the way the plugin and the CLI do, and shuts it down.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Io, run } from '@hafiz/cli'
import { DaemonClient, pidAlive, readLock, socketPathFor, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pluginSocketPath,
  projectOf,
  stopDaemon,
  userSocket,
  withStoreRead,
} from '../src/daemon.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})
const CLI_BIN = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function repo() {
  const cwd = tmp('hafiz-d-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-d-stores-'),
    HAFIZ_HOME: join(tmp('hafiz-d-home-'), 'home'),
    XDG_RUNTIME_DIR: tmp('hafiz-d-rt-'),
  }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  return { cwd, env, init: () => run(['init', 'Shop'], io) }
}

describe('plugin daemon discovery', () => {
  it('derives the socket exactly as the daemon and ensureDaemon do; none while untracked', async () => {
    const { cwd, env, init } = repo()
    expect(pluginSocketPath(cwd, env)).toBeUndefined()
    expect(projectOf(cwd, env)).toBeUndefined()
    expect(await init()).toBe(0)
    const d = await startDaemon({ projectDir: cwd, env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    expect(pluginSocketPath(cwd, env)).toBe(d.socketPath)
    expect(d.socketPath).toBe(socketPathFor(d.projectId, env))
    expect(d.socketPath.startsWith(join(env.XDG_RUNTIME_DIR as string, 'hafiz'))).toBe(true)
  })
})

describe('stopDaemon', () => {
  it('stops a detached `hafiz daemon` by the pid in the store lock, flushes, and is idempotent', async () => {
    const { cwd, env, init } = repo()
    expect(await init()).toBe(0)
    const child = spawn(process.execPath, [CLI_BIN, 'daemon', '--project', cwd], {
      env,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
    cleanup.push(() => void stopDaemon(cwd, env))
    const sock = pluginSocketPath(cwd, env) as string
    let client: DaemonClient | undefined
    for (let i = 0; i < 100 && !client; i++) {
      client = await DaemonClient.connect(sock).catch(() => undefined)
      if (!client) await sleep(100)
    }
    expect(client).toBeDefined()
    client?.close()
    const pid = readLock((projectOf(cwd, env) as { storeDir: string }).storeDir)?.pid as number
    expect(pid).toBe(child.pid)
    expect(await stopDaemon(cwd, env)).toBe(true)
    expect(pidAlive(pid)).toBe(false)
    expect(existsSync(sock)).toBe(false)
    expect(await stopDaemon(cwd, env)).toBe(false)
    // the store reads fine once the daemon is gone
    const blocks = await withStoreRead(cwd, env, (read) => read.listBlocks())
    expect(blocks).toHaveLength(1)
  }, 30000)

  it('userSocket starts a daemon on demand when none answers (a person running `hafiz review`)', async () => {
    const { cwd, env, init } = repo()
    expect(await userSocket(cwd, env)).toBeUndefined()
    expect(await init()).toBe(0)
    const sock = await userSocket(cwd, env)
    cleanup.push(() => void stopDaemon(cwd, env))
    expect(sock).toBe(pluginSocketPath(cwd, env))
    const c = await DaemonClient.connect(sock as string)
    c.close()
    expect(await stopDaemon(cwd, env)).toBe(true)
    await sleep(50)
    await expect(DaemonClient.connect(sock as string)).rejects.toThrow()
  }, 30000)
})
