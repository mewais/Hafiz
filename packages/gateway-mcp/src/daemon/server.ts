// The per-project daemon: lock the store, serve JSON-RPC on a Unix socket, exit when idle.
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { type Config, Core, loadConfig, resolveProject } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
import { acquireLock } from './lock.js'
import { ensureRuntimeDir, socketPathFor } from './paths.js'
import { RPC_CODES, type RpcRequest, type RpcResponse, toRpcError } from './rpc.js'
import { DaemonService } from './service.js'

export interface DaemonOptions {
  /** Any directory inside the repo (or the repo root). */
  projectDir: string
  env?: NodeJS.ProcessEnv
  config?: Config
  /** Overrides `hafiz.yaml daemon.idle_shutdown_seconds` (milliseconds; 0 disables). */
  idleShutdownMs?: number
}

export interface DaemonHandle {
  readonly projectId: string
  readonly storeDir: string
  readonly socketPath: string
  readonly service: DaemonService
  /** Resolves when the daemon has shut down (idle exit or `close()`). */
  readonly closed: Promise<void>
  close(): Promise<void>
}

export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const env = opts.env ?? process.env
  const project = resolveProject(opts.projectDir, env)
  const config = opts.config ?? loadConfig()
  const projectId = project.pointer.id
  ensureRuntimeDir(env)
  const socketPath = socketPathFor(projectId, env)

  const lock = acquireLock(project.storeDir, socketPath) // throws DaemonLockedError
  let backend: FsBackend | undefined
  let server: Server | undefined
  try {
    backend = new FsBackend({
      dir: project.storeDir,
      minorBatchSeconds: config.hafiz.storage.git.minor_write_batch_seconds,
    })
    await backend.open()
    const service = new DaemonService(new Core({ config, backend }))
    await service.init()

    const sockets = new Set<Socket>()
    const idleMs = opts.idleShutdownMs ?? config.hafiz.daemon.idle_shutdown_seconds * 1000
    let idleTimer: NodeJS.Timeout | null = null
    let closing: Promise<void> | null = null
    let resolveClosed!: () => void
    const closed = new Promise<void>((r) => {
      resolveClosed = r
    })

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      if (idleMs > 0 && sockets.size === 0) idleTimer = setTimeout(() => void close(), idleMs)
      idleTimer?.unref()
    }

    const srv = createServer((sock) => {
      sockets.add(sock)
      armIdle()
      serve(sock, service)
      sock.on('close', () => {
        sockets.delete(sock)
        armIdle()
      })
    })
    server = srv

    if (existsSync(socketPath)) unlinkSync(socketPath) // stale: we hold the lock
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(socketPath, () => {
        srv.off('error', reject)
        resolve()
      })
    })
    chmodSync(socketPath, 0o600)
    armIdle()

    const be = backend
    const close = (): Promise<void> => {
      closing ??= (async () => {
        if (idleTimer) clearTimeout(idleTimer)
        await new Promise<void>((r) => srv.close(() => r()))
        for (const s of sockets) s.destroy()
        await service.idle()
        await be.close() // flushes batched minor writes
        try {
          unlinkSync(socketPath)
        } catch {}
        lock.release()
        resolveClosed()
      })()
      return closing
    }

    return {
      projectId,
      storeDir: project.storeDir,
      socketPath,
      service,
      closed,
      close,
    }
  } catch (e) {
    server?.close()
    await backend?.close().catch(() => undefined)
    lock.release()
    throw e
  }
}

/** Newline-delimited JSON-RPC on one connection. */
function serve(sock: Socket, service: DaemonService): void {
  let buf = ''
  const send = (r: RpcResponse) => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(r)}\n`)
  }
  const onLine = async (line: string) => {
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
    } catch {
      return send({
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_CODES.parse_error, message: 'parse error' },
      })
    }
    if (req?.jsonrpc !== '2.0' || typeof req.method !== 'string' || req.id === undefined)
      return send({
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: { code: RPC_CODES.invalid_request, message: 'invalid request' },
      })
    try {
      const result = await service.handle(req.method, req.params ?? {})
      send({ jsonrpc: '2.0', id: req.id, result: result ?? null })
    } catch (e) {
      send({ jsonrpc: '2.0', id: req.id, error: toRpcError(e) })
    }
  }
  sock.setEncoding('utf8')
  sock.on('data', (chunk: string) => {
    buf += chunk
    let i = buf.indexOf('\n')
    while (i >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) void onLine(line)
      i = buf.indexOf('\n')
    }
  })
  sock.on('error', () => sock.destroy())
}
