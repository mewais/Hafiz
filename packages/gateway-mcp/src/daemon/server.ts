// The per-project daemon: lock the store, serve JSON-RPC on a Unix socket, exit when idle.
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import {
  type Config,
  Core,
  type CoreDeps,
  configDirs,
  loadConfig,
  resolveProject,
  type StorageBackend,
} from '@hafiz/core'
import { createBackend } from '../backend.js'
import { acquireLock } from './lock.js'
import { ensureRuntimeDir, socketPathFor } from './paths.js'
import { RPC_CODES, RpcPeer, type RpcRequest, type RpcResponse, toRpcError } from './rpc.js'
import { DaemonService, LlmRelayHub } from './service.js'

export interface DaemonOptions {
  /** Any directory inside the repo (or the repo root). */
  projectDir: string
  env?: NodeJS.ProcessEnv
  config?: Config
  /** LLM providers instead of the ones `hafiz.yaml llm.*` names (tests). */
  llm?: CoreDeps['llm']
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
  const config = opts.config ?? loadConfig(configDirs(project.storeDir, env))
  const projectId = project.pointer.id
  ensureRuntimeDir(env)
  const socketPath = socketPathFor(projectId, env)

  const lock = acquireLock(project.storeDir, socketPath) // throws DaemonLockedError
  let backend: StorageBackend | undefined
  let server: Server | undefined
  try {
    backend = createBackend(config, project.storeDir)
    await backend.open()
    // Relayed LLM providers (`kilo`) run in the host plugin that registered over its connection.
    const relay = new LlmRelayHub()
    const service = new DaemonService(
      new Core({
        config,
        backend,
        env,
        // Fallback only: sessions name their own working tree at open (worktrees share a daemon).
        repoDir: project.worktree,
        relay,
        ...(opts.llm ? { llm: opts.llm } : {}),
      }),
      relay,
    )
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

/** Newline-delimited JSON-RPC on one connection (requests both ways; see RpcPeer). */
function serve(sock: Socket, service: DaemonService): void {
  let buf = ''
  const write = (line: string) => {
    if (!sock.destroyed) sock.write(line)
  }
  const send = (r: RpcResponse) => write(`${JSON.stringify(r)}\n`)
  const peer = new RpcPeer(write)
  sock.on('close', () => {
    peer.close()
    service.disconnected(peer)
  })
  const onLine = async (line: string) => {
    let req: RpcRequest
    try {
      req = JSON.parse(line) as RpcRequest
      // an answer to a request the daemon sent this client
      if (req && typeof req === 'object' && !('method' in req) && peer.settle(req as RpcResponse))
        return
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
      const result = await service.handle(req.method, req.params ?? {}, peer)
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
