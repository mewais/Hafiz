// A scripted LLM server for tests: OpenAI Chat Completions (`/v1/chat/completions`) and Anthropic
// Messages (`/v1/messages`), streaming and not, text or tool calls. Records every request.
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ScriptedToolCall {
  name: string
  arguments: Record<string, unknown>
  id?: string
}

/** One scripted assistant reply. Text, tool calls, or both. */
export interface ScriptedReply {
  text?: string
  toolCalls?: ScriptedToolCall[]
  /** Answer with this HTTP error status instead of a completion. */
  status?: number
  /** Reported token usage (defaults: input 10, output 5, no cache). */
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export interface RecordedRequest {
  method: string
  path: string
  headers: IncomingHttpHeaders
  /** Raw body bytes as received. */
  raw: string
  body: unknown
}

export interface MockLlmOptions {
  /** Delay between streamed chunks (ms). */
  chunkDelayMs?: number
  /** Reply when the script is empty. */
  fallback?: ScriptedReply | ((req: RecordedRequest) => ScriptedReply)
}

export interface MockLlm {
  url: string
  requests: RecordedRequest[]
  /** Queue replies, consumed in order. */
  script(...replies: ScriptedReply[]): void
  close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Split a reply into a few streamed text pieces so streaming is observable. */
function pieces(text: string): string[] {
  const words = text.split(/(?<= )/)
  return words.length ? words : ['']
}

export async function startMockLlm(opts: MockLlmOptions = {}): Promise<MockLlm> {
  const requests: RecordedRequest[] = []
  const queue: ScriptedReply[] = []
  const delay = opts.chunkDelayMs ?? 0
  let callSeq = 0

  const next = (req: RecordedRequest): ScriptedReply => {
    const q = queue.shift()
    if (q) return q
    const f = opts.fallback ?? { text: 'ok' }
    return typeof f === 'function' ? f(req) : f
  }

  async function openai(res: ServerResponse, body: Record<string, unknown>, reply: ScriptedReply) {
    const id = `chatcmpl-${++callSeq}`
    const model = String(body.model ?? 'mock')
    const created = 1700000000
    const toolCalls = (reply.toolCalls ?? []).map((t, i) => ({
      index: i,
      id: t.id ?? `call_${callSeq}_${i}`,
      type: 'function' as const,
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    }))
    const finish = toolCalls.length ? 'tool_calls' : 'stop'
    const u = { input: 10, output: 5, cacheRead: 0, ...reply.usage }
    const usage = {
      prompt_tokens: u.input + u.cacheRead,
      completion_tokens: u.output,
      total_tokens: u.input + u.cacheRead + u.output,
      ...(u.cacheRead ? { prompt_tokens_details: { cached_tokens: u.cacheRead } } : {}),
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: reply.text ?? null,
                ...(toolCalls.length
                  ? { tool_calls: toolCalls.map(({ index: _i, ...t }) => t) }
                  : {}),
              },
              finish_reason: finish,
            },
          ],
          usage,
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const send = async (delta: Record<string, unknown>, finishReason: string | null = null) => {
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      if (delay) await sleep(delay)
    }
    await send({ role: 'assistant', content: '' })
    if (reply.text) for (const p of pieces(reply.text)) await send({ content: p })
    for (const t of toolCalls) await send({ tool_calls: [t] })
    await send({}, finish)
    const so = body.stream_options as { include_usage?: boolean } | undefined
    if (so?.include_usage)
      res.write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`,
      )
    res.end('data: [DONE]\n\n')
  }

  async function anthropic(
    res: ServerResponse,
    body: Record<string, unknown>,
    reply: ScriptedReply,
  ) {
    const id = `msg_${++callSeq}`
    const model = String(body.model ?? 'mock')
    const blocks: Array<Record<string, unknown>> = []
    if (reply.text) blocks.push({ type: 'text', text: reply.text })
    for (const [i, t] of (reply.toolCalls ?? []).entries())
      blocks.push({
        type: 'tool_use',
        id: t.id ?? `toolu_${callSeq}_${i}`,
        name: t.name,
        input: t.arguments,
      })
    const stop = reply.toolCalls?.length ? 'tool_use' : 'end_turn'
    const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...reply.usage }
    const usage = {
      input_tokens: u.input,
      output_tokens: u.output,
      cache_read_input_tokens: u.cacheRead,
      cache_creation_input_tokens: u.cacheWrite,
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: blocks,
          stop_reason: stop,
          stop_sequence: null,
          usage,
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    const ev = async (type: string, data: Record<string, unknown>) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      if (delay) await sleep(delay)
    }
    await ev('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    })
    for (const [index, b] of blocks.entries()) {
      if (b.type === 'text') {
        await ev('content_block_start', { index, content_block: { type: 'text', text: '' } })
        for (const p of pieces(String(b.text)))
          await ev('content_block_delta', { index, delta: { type: 'text_delta', text: p } })
      } else {
        await ev('content_block_start', {
          index,
          content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
        })
        await ev('content_block_delta', {
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        })
      }
      await ev('content_block_stop', { index })
    }
    await ev('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: u.output },
    })
    await ev('message_stop', {})
    res.end()
  }

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const path = req.url ?? '/'
      const rec: RecordedRequest = {
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        raw,
        body,
      }
      requests.push(rec)
      const b = (body ?? {}) as Record<string, unknown>
      const done = (p: Promise<void>) =>
        p.catch((e) => {
          if (!res.headersSent) res.writeHead(500)
          res.end(String(e))
        })
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      } else if (path.endsWith('/chat/completions') || path.endsWith('/messages')) {
        const reply = next(rec)
        if (reply.status) {
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `mock: scripted ${reply.status}` } }))
        } else done((path.endsWith('/messages') ? anthropic : openai)(res, b, reply))
      } else {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: no route ${path}` } }))
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    script: (...r) => {
      queue.push(...r)
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
