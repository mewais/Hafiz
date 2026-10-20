// JSON-RPC 2.0 over newline-delimited JSON. Shared by server and client.
import { type ErrorCode, HafizError } from '@hafiz/core'

export interface RpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface RpcErrorBody {
  code: number
  message: string
  data?: unknown
}

export interface RpcResponse {
  jsonrpc: '2.0'
  id: number | string | null
  result?: unknown
  error?: RpcErrorBody
}

/** Stable integer codes: standard JSON-RPC ones plus -320xx for Hafiz errors. */
export const RPC_CODES = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal: -32603,
  unauthorized: -32001,
  forbidden: -32003,
  not_found: -32004,
  conflict: -32009,
  validation: -32022,
  cap_exceeded: -32023,
  guard_failed: -32024,
  invalid_transition: -32025,
  store: -32030,
} as const satisfies Record<string, number>

export function toRpcError(e: unknown): RpcErrorBody {
  if (e instanceof HafizError)
    return { code: RPC_CODES[e.code], message: e.message, data: e.toJSON() }
  if (e instanceof RpcFailure) return e.body
  return { code: RPC_CODES.internal, message: e instanceof Error ? e.message : String(e) }
}

/** Thrown inside the daemon for protocol-level failures. */
export class RpcFailure extends Error {
  constructor(readonly body: RpcErrorBody) {
    super(body.message)
  }
}

/** Client-side view of an error response. `data` is the HafizError JSON when it was one. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
  /** The Hafiz error code (`conflict`, `forbidden`, …) if this wraps a HafizError. */
  get hafizCode(): ErrorCode | undefined {
    const d = this.data as { code?: ErrorCode } | undefined
    return d && typeof d === 'object' ? d.code : undefined
  }
}

type Waiter = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }

/**
 * The reverse direction on one connection: the daemon asks a client (a host plugin that
 * registered as an LLM relay) to run something and waits for its answer. Ids are strings
 * (`d1`, `d2`, …) so they never collide with the client's numeric ids.
 */
export class RpcPeer {
  private next = 1
  private readonly waiting = new Map<string, Waiter>()
  private closed = false

  constructor(private readonly write: (line: string) => void) {}

  request<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'))
    const id = `d${this.next++}`
    return new Promise<T>((resolve, reject) => {
      const w: Waiter = { resolve: resolve as (v: unknown) => void, reject }
      if (opts.timeoutMs)
        w.timer = setTimeout(() => {
          this.waiting.delete(id)
          reject(new Error(`${method} timed out after ${opts.timeoutMs} ms`))
        }, opts.timeoutMs)
      opts.signal?.addEventListener('abort', () => {
        if (!this.waiting.delete(id)) return
        clearTimeout(w.timer)
        reject(new Error(`${method} aborted`))
      })
      this.waiting.set(id, w)
      this.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  /** A response line from the client; false when it answers nothing we asked. */
  settle(res: RpcResponse): boolean {
    const w = typeof res.id === 'string' ? this.waiting.get(res.id) : undefined
    if (!w) return false
    this.waiting.delete(res.id as string)
    clearTimeout(w.timer)
    if (res.error) w.reject(new RpcError(res.error.code, res.error.message, res.error.data))
    else w.resolve(res.result)
    return true
  }

  close(): void {
    this.closed = true
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer)
      w.reject(new Error('connection closed'))
    }
    this.waiting.clear()
  }
}
