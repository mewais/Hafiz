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
