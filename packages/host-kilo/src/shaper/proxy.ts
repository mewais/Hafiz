// embedded-proxy: an HTTP server inside the plugin process (127.0.0.1, random port). The `config`
// hook points each wrapped provider's baseURL at `/p/<provider>/`; the proxy forwards to the
// remembered original. Kilo attaches auth; the proxy forwards every header untouched except its
// own `x-hafiz-session` marker. Responses (SSE included) are piped, never buffered.
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { applyAnthropic, isMessages, parseAnthropic } from '../wire/anthropic.js'
import { applyOpenAi, isChatCompletions, parseOpenAi } from '../wire/openai.js'
import { UsageTap, type WireUsage } from '../wire/usage.js'
import type { ConversationShaper } from './core.js'
import type { RequestShaper } from './types.js'

/** Header the plugin's `chat.headers` hook adds to requests of managed sessions. */
export const SESSION_HEADER = 'x-hafiz-session'

export interface ProxyRequest {
  /** Path below the provider's base URL, e.g. `/chat/completions`. */
  path: string
  headers: IncomingHttpHeaders
  body: Buffer
}

export type WireFormat = 'openai-chat' | 'anthropic-messages'

export function wireFormat(path: string): WireFormat | null {
  const p = path.split('?')[0] ?? ''
  if (p.endsWith('/chat/completions')) return 'openai-chat'
  if (p.endsWith('/messages')) return 'anthropic-messages'
  return null
}

export interface EmbeddedProxyOptions {
  shaper: ConversationShaper
  log?: (line: string) => void
  /** Token usage of a managed session's completed response (streamed or not). */
  onUsage?: (sessionId: string, usage: WireUsage) => void
}

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  SESSION_HEADER,
])

export class EmbeddedProxy implements RequestShaper<ProxyRequest> {
  readonly kind = 'embedded-proxy' as const
  private server: Server | undefined
  private base: string | undefined
  private readonly upstreams = new Map<string, string>()

  constructor(private readonly opts: EmbeddedProxyOptions) {}

  /** Start listening (idempotent); resolves to the proxy's base URL. */
  async start(): Promise<string> {
    if (this.base) return this.base
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void this.forward(
          req.method ?? 'GET',
          req.url ?? '/',
          req.headers,
          Buffer.concat(chunks),
          res,
          req,
        )
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    server.unref()
    this.server = server
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return this.base
  }

  /** Remember a provider's real base URL; returns the base URL Kilo should use instead. */
  wrap(providerId: string, originalBaseURL: string): string {
    if (!this.base) throw new Error('proxy not started')
    this.upstreams.set(providerId, originalBaseURL.replace(/\/+$/, ''))
    return `${this.base}/p/${encodeURIComponent(providerId)}`
  }

  upstreamOf(providerId: string): string | undefined {
    return this.upstreams.get(providerId)
  }

  async shape(req: ProxyRequest): Promise<ProxyRequest> {
    const sessionId = header(req.headers, SESSION_HEADER)
    const format = wireFormat(req.path)
    if (!sessionId || !format || !this.opts.shaper.isManaged(sessionId)) return req
    try {
      const body = JSON.parse(req.body.toString('utf8')) as unknown
      const model = (body as { model?: unknown }).model
      const m = typeof model === 'string' ? model : undefined
      let out: unknown
      if (format === 'openai-chat' && isChatCompletions(body)) {
        const parsed = parseOpenAi(body)
        const shaped = await this.opts.shaper.shape({
          sessionId,
          model: m,
          conversation: parsed.conversation,
        })
        if (!shaped) return req
        out = applyOpenAi(body, parsed, shaped)
      } else if (format === 'anthropic-messages' && isMessages(body)) {
        const parsed = parseAnthropic(body)
        const shaped = await this.opts.shaper.shape({
          sessionId,
          model: m,
          conversation: parsed.conversation,
        })
        if (!shaped) return req
        out = applyAnthropic(body, shaped)
      } else return req
      return { ...req, body: Buffer.from(JSON.stringify(out), 'utf8') }
    } catch (e) {
      this.opts.log?.(`hafiz proxy: shaping failed, passing through: ${String(e)}`)
      return req
    }
  }

  private async forward(
    method: string,
    url: string,
    headers: IncomingHttpHeaders,
    body: Buffer,
    res: import('node:http').ServerResponse,
    req: import('node:http').IncomingMessage,
  ): Promise<void> {
    const m = /^\/p\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url)
    const upstream = m ? this.upstreams.get(decodeURIComponent(m[1] as string)) : undefined
    if (!m || !upstream) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `hafiz proxy: unknown route ${url}` } }))
      return
    }
    const path = m[2] ?? ''
    const shaped =
      method === 'POST' ? await this.shape({ path, headers, body }) : { path, headers, body }
    const target = new URL(`${upstream}${path}${m[3] ?? ''}`)
    const out: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(headers))
      if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v
    if (method !== 'GET' && method !== 'HEAD') out['content-length'] = String(shaped.body.length)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const sessionId = header(headers, SESSION_HEADER)
    const format = wireFormat(path)
    const up = send(target, { method, headers: out }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.statusMessage ?? '', ur.headers)
      res.flushHeaders()
      if (this.opts.onUsage && sessionId && format && ur.statusCode === 200) {
        // Observe only: the pipe below is the response; this reads the same chunks.
        const tap = new UsageTap(format, header(ur.headers, 'content-type'))
        ur.on('data', (c: Buffer) => tap.push(c))
        ur.on('end', () => {
          try {
            const u = tap.result()
            if (u) this.opts.onUsage?.(sessionId, u)
          } catch {}
        })
      }
      ur.pipe(res)
    })
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `hafiz proxy: upstream error: ${e.message}` } }))
    })
    res.on('close', () => {
      if (!res.writableFinished) up.destroy()
    })
    req.on('aborted', () => up.destroy())
    up.end(method === 'GET' || method === 'HEAD' ? undefined : shaped.body)
  }

  async close(): Promise<void> {
    const s = this.server
    if (!s) return
    this.server = undefined
    this.base = undefined
    await new Promise<void>((r) => {
      s.closeAllConnections()
      s.close(() => r())
    })
  }
}

function header(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name]
  return Array.isArray(v) ? v[0] : v
}
