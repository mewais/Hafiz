// The TUI panel's data: it runs in Kilo's TUI thread, apart from the server plugin (Kilo runs
// the server in a worker), so it opens its own daemon connection as a `viewer` session: a
// read_only role the daemon refuses every write for. Everything here is a read: tree.summary,
// project.status (sessions, focus, counters), proposal.list, notices.peek (never drains),
// block.read and block.history.
import {
  configDirs,
  type DecisionBrief,
  findPointerFile,
  type HistoryEntry,
  loadConfig,
  type Proposal,
  type ResolvedProject,
  resolveProject,
} from '@hafiz/core'
import {
  DaemonClient,
  type ProjectStatus,
  type QueuedNotice,
  RPC_CODES,
  RpcError,
  socketPathFor,
} from '@hafiz/gateway-mcp/client'
import type { TuiNode } from './model.js'

/** The viewer session id; every Kilo TUI of the project re-attaches to it. */
export const VIEWER_SESSION = 'kilo-tui'

export interface TuiSnapshot {
  project: string
  nodes: TuiNode[]
  standing: DecisionBrief[]
  sessions: Map<string, ProjectStatus['sessions'][number]>
  pending: Proposal[]
  /** When it was read (ms). */
  at: number
}

export interface TuiProject {
  project: ResolvedProject
  zooms: string[]
}

/** The Hafiz project of `dir`, or undefined (no pointer: the TUI plugin registers nothing). */
export function detectTuiProject(dir: string, env: NodeJS.ProcessEnv): TuiProject | undefined {
  if (!findPointerFile(dir)) return undefined
  try {
    const project = resolveProject(dir, env)
    const config = loadConfig(configDirs(project.storeDir, env))
    return { project, zooms: Object.keys(config.zooms.zooms).filter((z) => z !== 'NONE') }
  } catch {
    return undefined
  }
}

export interface TuiSourceOptions {
  project: ResolvedProject
  connect?: (p: ResolvedProject) => Promise<DaemonClient>
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

const unauthorized = (e: unknown) => e instanceof RpcError && e.code === RPC_CODES.unauthorized

/**
 * One viewer connection. Never starts a daemon: when none runs the panel shows nothing (the
 * server plugin starts it on the first managed message).
 */
export class TuiSource {
  private client: Promise<DaemonClient> | undefined
  private closed = false

  constructor(private readonly opts: TuiSourceOptions) {}

  private connect(): Promise<DaemonClient> {
    if (this.closed) return Promise.reject(new Error('closed'))
    if (!this.client) {
      const env = this.opts.env ?? process.env
      const open = async () => {
        const c = await (this.opts.connect
          ? this.opts.connect(this.opts.project)
          : DaemonClient.connect(socketPathFor(this.opts.project.pointer.id, env)))
        c.onClose(() => {
          this.client = undefined
        })
        await c.openSession({ id: VIEWER_SESSION, host: 'kilo-tui', role: 'viewer' })
        return c
      }
      this.client = open()
      this.client.catch(() => {
        this.client = undefined
      })
    }
    return this.client
  }

  /** A read; on a revoked token (session ended elsewhere) the viewer session is reopened once. */
  private async read<T>(f: (c: DaemonClient) => Promise<T>): Promise<T> {
    const c = await this.connect()
    try {
      return await f(c)
    } catch (e) {
      if (!unauthorized(e)) throw e
      await c.openSession({ id: VIEWER_SESSION, host: 'kilo-tui', role: 'viewer' })
      return f(c)
    }
  }

  async snapshot(): Promise<TuiSnapshot> {
    return this.read(async (c) => {
      const [tree, status, pending] = await Promise.all([
        c.treeSummary(),
        c.projectStatus(),
        c.proposalList('pending'),
      ])
      return {
        project: tree.project?.name ?? status.project?.name ?? '',
        nodes: tree.nodes,
        standing: tree.standing,
        sessions: new Map(status.sessions.map((s) => [s.id, s])),
        pending,
        at: Date.now(),
      }
    })
  }

  /** Recent notices of a Kilo session (= its Hafiz session id), without draining them. */
  notices(sessionId: string): Promise<QueuedNotice[]> {
    return this.read((c) => c.noticesPeek(sessionId)).catch(() => [])
  }

  blockRead(id: string, zoom: string): Promise<string> {
    return this.read((c) => c.blockRead(id, zoom))
  }

  history(id: string): Promise<HistoryEntry[]> {
    return this.read((c) => c.blockHistory(id))
  }

  close(): void {
    this.closed = true
    const c = this.client
    this.client = undefined
    void c?.then((x) => x.close()).catch(() => undefined)
  }
}
