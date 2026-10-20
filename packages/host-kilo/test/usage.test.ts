// Token usage off the wire: both formats, streamed and not, split at arbitrary chunk
// boundaries; and through the embedded proxy without disturbing the stream.
import { afterEach, describe, expect, it } from 'vitest'
import { EmbeddedProxy, SESSION_HEADER, UsageTap, type WireUsage } from '../src/index.js'
import { fakeSource, fixture, shaperFor } from './helpers.js'
import { startMockLlm } from './mock-llm.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

function feed(tap: UsageTap, body: string, size: number) {
  const buf = Buffer.from(body, 'utf8')
  for (let i = 0; i < buf.length; i += size) tap.push(buf.subarray(i, i + size))
  return tap.result()
}

describe('UsageTap', () => {
  const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

  it('OpenAI JSON: cached tokens are split out of the prompt count', () => {
    const body = JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 7,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    })
    expect(feed(new UsageTap('openai-chat', 'application/json'), body, 17)).toEqual({
      input: 20,
      output: 7,
      cacheRead: 100,
      cacheWrite: 0,
    })
  })

  it('OpenAI SSE: usage comes from the final chunk, whatever the chunking', () => {
    const body = `${sse(
      { choices: [{ delta: { content: 'héllo' } }], usage: null },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
    )}data: [DONE]\n\n`
    for (const size of [1, 3, 64, 4096])
      expect(
        feed(new UsageTap('openai-chat', 'text/event-stream; charset=utf-8'), body, size),
      ).toEqual({
        input: 50,
        output: 9,
        cacheRead: 0,
        cacheWrite: 0,
      })
  })

  it('Anthropic JSON and SSE: cache read and write, output from message_delta', () => {
    const usage = {
      input_tokens: 12,
      output_tokens: 30,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 40,
    }
    const want: WireUsage = { input: 12, output: 30, cacheRead: 800, cacheWrite: 40 }
    expect(
      feed(new UsageTap('anthropic-messages', 'application/json'), JSON.stringify({ usage }), 9),
    ).toEqual(want)
    const body = sse(
      { type: 'message_start', message: { usage: { ...usage, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    )
    for (const size of [2, 50, 9999])
      expect(feed(new UsageTap('anthropic-messages', 'text/event-stream'), body, size)).toEqual(
        want,
      )
  })

  it('reports nothing for bodies without usage, errors or garbage', () => {
    expect(feed(new UsageTap('openai-chat', 'application/json'), '{"error":{}}', 5)).toBeUndefined()
    expect(feed(new UsageTap('openai-chat', 'application/json'), 'not json', 5)).toBeUndefined()
    expect(
      feed(new UsageTap('anthropic-messages', 'text/event-stream'), 'data: {"usage":\n\n', 5),
    ).toBeUndefined()
  })

  it('does not buffer a stream: memory stays at one partial line', () => {
    const tap = new UsageTap('openai-chat', 'text/event-stream')
    for (let i = 0; i < 2000; i++)
      tap.push(Buffer.from(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`))
    // @ts-expect-error private, inspected on purpose
    expect(tap.line).toBe('')
    // @ts-expect-error private, inspected on purpose
    expect(tap.json).toHaveLength(0)
  })
})

describe('embedded proxy usage', () => {
  async function setup() {
    const mock = await startMockLlm()
    const seen: Array<[string, WireUsage]> = []
    const proxy = new EmbeddedProxy({
      shaper: shaperFor(fakeSource()),
      onUsage: (id, u) => seen.push([id, u]),
    })
    await proxy.start()
    cleanup.push(
      () => mock.close(),
      () => proxy.close(),
    )
    return {
      mock,
      seen,
      openai: proxy.wrap('mock', `${mock.url}/v1`),
      anthropic: proxy.wrap('mocka', `${mock.url}/v1`),
    }
  }
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: 's1', ...headers },
      body,
    })

  it('OpenAI: streamed and non-streamed responses are reported and delivered intact', async () => {
    const { mock, seen, openai } = await setup()
    const base = JSON.parse(fixture('openai-chat.json')) as Record<string, unknown>
    mock.script(
      { text: 'a b c', usage: { input: 30, output: 4, cacheRead: 200 } },
      { text: 'd e f', usage: { input: 5, output: 6 } },
    )
    const plain = await (
      await post(`${openai}/chat/completions`, JSON.stringify({ ...base, stream: false }))
    ).text()
    expect(JSON.parse(plain).choices[0].message.content).toBe('a b c')
    const streamed = await (
      await post(
        `${openai}/chat/completions`,
        JSON.stringify({ ...base, stream: true, stream_options: { include_usage: true } }),
      )
    ).text()
    expect(streamed).toContain('"content":"e "')
    expect(seen).toEqual([
      ['s1', { input: 30, output: 4, cacheRead: 200, cacheWrite: 0 }],
      ['s1', { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 }],
    ])
  })

  it('Anthropic: cache figures from streamed and non-streamed responses', async () => {
    const { mock, seen, anthropic } = await setup()
    const base = JSON.parse(fixture('anthropic-messages.json')) as Record<string, unknown>
    mock.script(
      { text: 'x', usage: { input: 3, output: 8, cacheRead: 900, cacheWrite: 50 } },
      { text: 'y', usage: { input: 4, output: 9, cacheRead: 910 } },
    )
    await (
      await post(`${anthropic}/messages`, JSON.stringify({ ...base, stream: false }), {
        'x-api-key': 'k',
      })
    ).text()
    await (
      await post(`${anthropic}/messages`, JSON.stringify({ ...base, stream: true }), {
        'x-api-key': 'k',
      })
    ).text()
    expect(seen.map(([, u]) => u)).toEqual([
      { input: 3, output: 8, cacheRead: 900, cacheWrite: 50 },
      { input: 4, output: 9, cacheRead: 910, cacheWrite: 0 },
    ])
  })

  it('unmanaged requests and failed responses report nothing', async () => {
    const { seen, openai } = await setup()
    const body = fixture('openai-chat.json')
    await (await post(`${openai}/chat/completions`, body, { [SESSION_HEADER]: '' })).text()
    await (await fetch(`${openai}/chat/completions`, { method: 'POST', body })).text()
    expect(seen).toEqual([])
  })
})
