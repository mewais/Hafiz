import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddedProxy, SESSION_HEADER } from '../src/index.js'
import { fakeSource, fixture, shaperFor } from './helpers.js'
import { type MockLlm, startMockLlm } from './mock-llm.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function setup(chunkDelayMs = 0) {
  const mock = await startMockLlm({ chunkDelayMs })
  const proxy = new EmbeddedProxy({ shaper: shaperFor(fakeSource()) })
  await proxy.start()
  cleanup.push(
    () => mock.close(),
    () => proxy.close(),
  )
  const openai = proxy.wrap('mock', `${mock.url}/v1/`)
  const anthropic = proxy.wrap('mocka', `${mock.url}/v1`)
  return { mock, proxy, openai, anthropic }
}

/** Read a streamed body, timing each chunk's arrival. */
async function readTimed(res: Response) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  const chunks: Array<{ at: number; text: string }> = []
  const t0 = Date.now()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push({ at: Date.now() - t0, text: dec.decode(value) })
  }
  return chunks
}

const lastBody = (m: MockLlm) => m.requests.at(-1)?.raw as string

describe('embedded proxy', () => {
  it('streams OpenAI SSE through incrementally, forwards auth, shapes managed sessions', async () => {
    const { mock, openai } = await setup(40)
    mock.script({ text: 'one two three four five six' })
    const res = await fetch(`${openai}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-secret',
        [SESSION_HEADER]: 's1',
      },
      body: fixture('openai-chat.json'),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const chunks = await readTimed(res)
    expect(chunks.length).toBeGreaterThan(3)
    // the first chunk arrived well before the stream ended: nothing was buffered
    expect((chunks.at(-1)?.at ?? 0) - (chunks[0]?.at ?? 0)).toBeGreaterThan(150)
    const text = chunks.map((c) => c.text).join('')
    expect(text).toContain('"content":"three "')
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    const req = mock.requests.at(-1)
    expect(req?.path).toBe('/v1/chat/completions')
    expect(req?.headers.authorization).toBe('Bearer sk-secret')
    expect(req?.headers[SESSION_HEADER]).toBeUndefined()
    expect(req?.raw).toContain('<hafiz hash=')
  })

  it('passes unknown or unmarked sessions through byte for byte', async () => {
    const { mock, openai } = await setup()
    const raw = fixture('openai-chat.json')
    for (const headers of [{ [SESSION_HEADER]: 'nobody' }, {}]) {
      const res = await fetch(`${openai}/chat/completions?x=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: raw,
      })
      await res.text()
      expect(lastBody(mock)).toBe(raw)
      expect(mock.requests.at(-1)?.path).toBe('/v1/chat/completions?x=1')
    }
  })

  it('handles Anthropic streaming and non-POST routes', async () => {
    const { mock, anthropic } = await setup(10)
    mock.script({
      text: 'hello there',
      toolCalls: [{ name: 'read', arguments: { filePath: '/a' } }],
    })
    const res = await fetch(`${anthropic}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-ant',
        'anthropic-version': '2023-06-01',
        [SESSION_HEADER]: 's1',
      },
      body: fixture('anthropic-messages.json'),
    })
    const text = await res.text()
    expect(text).toContain('event: message_stop')
    expect(text).toContain('"partial_json":"{\\"filePath\\":\\"/a\\"}"')
    const req = mock.requests.at(-1)
    expect(req?.headers['x-api-key']).toBe('sk-ant')
    expect(req?.headers['anthropic-version']).toBe('2023-06-01')
    expect((req?.body as { system: unknown[] } | undefined)?.system).toHaveLength(3)
    const models = await fetch(`${anthropic}/models`)
    expect(((await models.json()) as { data: unknown[] }).data).toHaveLength(1)
  })

  it('answers 404 for unknown providers and 502 when the upstream is down', async () => {
    const { proxy } = await setup()
    const base = proxy.wrap('dead', 'http://127.0.0.1:9')
    expect((await fetch(`${base.replace('/p/dead', '/p/nope')}/chat/completions`)).status).toBe(404)
    const r = await fetch(`${base}/chat/completions`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(502)
  })
})
