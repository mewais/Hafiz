// The LLMProvider implementations over real HTTP against the scripted mock server, and the
// condenser driving each of them.
import {
  Condenser,
  createProvider,
  estimatorTokenizer,
  LLMError,
  type LLMSettings,
} from '@hafiz/core'
import { afterEach, describe, expect, it } from 'vitest'
import { type MockLlm, startMockLlm } from './mock-llm.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})
async function mock(): Promise<MockLlm> {
  const m = await startMockLlm()
  cleanup.push(() => m.close())
  return m
}

const env = { KEY: 'sk-test' }
const req = { system: 'be brief', prompt: 'hello', maxTokens: 123 }
const settings = (m: MockLlm, o: Partial<LLMSettings>): LLMSettings => ({
  provider: 'openai-compatible',
  model: 'tiny',
  api_key_env: 'KEY',
  base_url: `${m.url}/v1`,
  ...o,
})

describe('openai-compatible provider', () => {
  it('posts chat completions with bearer auth and returns text and usage', async () => {
    const m = await mock()
    m.script({ text: 'hi there', usage: { input: 20, output: 3, cacheRead: 50 } })
    const p = createProvider(settings(m, {}), { env })
    const r = await p.complete({ ...req, json: true })
    expect(r.text).toBe('hi there')
    expect(r.usage).toEqual({ inputTokens: 70, outputTokens: 3, cacheReadTokens: 50 })
    const got = m.requests[0]
    expect(got?.path).toBe('/v1/chat/completions')
    expect(got?.headers.authorization).toBe('Bearer sk-test')
    expect(got?.body).toMatchObject({
      model: 'tiny',
      max_tokens: 123,
      temperature: 0,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
      response_format: { type: 'json_object' },
    })
  })

  it('explains configuration mistakes instead of sending anything', async () => {
    const m = await mock()
    await expect(createProvider(settings(m, {}), { env: {} }).complete(req)).rejects.toThrow(
      /KEY is not set/,
    )
    await expect(
      createProvider(settings(m, { model: 'cheap' }), { env }).complete(req),
    ).rejects.toThrow(/real model id/)
    await expect(
      createProvider(settings(m, { api_key_env: undefined }), { env }).complete(req),
    ).rejects.toThrow(/api_key_env/)
    expect(m.requests).toEqual([])
  })

  it('surfaces HTTP errors and unreachable servers as LLMError', async () => {
    const m = await mock()
    m.script({ status: 429 })
    const bad = createProvider(settings(m, {}), { env })
    await expect(bad.complete(req)).rejects.toMatchObject({ name: 'LLMError', status: 429 })
    const down = createProvider(settings(m, { base_url: 'http://127.0.0.1:9/v1' }), { env })
    await expect(down.complete(req)).rejects.toBeInstanceOf(LLMError)
  })
})

describe('anthropic provider', () => {
  it('posts messages with x-api-key and version, system as a field', async () => {
    const m = await mock()
    m.script({ text: 'bonjour', usage: { input: 7, output: 2, cacheRead: 300, cacheWrite: 40 } })
    const p = createProvider(settings(m, { provider: 'anthropic', base_url: m.url }), { env })
    const r = await p.complete(req)
    expect(r.text).toBe('bonjour')
    expect(r.usage).toEqual({
      inputTokens: 347,
      outputTokens: 2,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
    })
    const got = m.requests[0]
    expect(got?.path).toBe('/v1/messages')
    expect(got?.headers['x-api-key']).toBe('sk-test')
    expect(got?.headers['anthropic-version']).toBe('2023-06-01')
    expect(got?.body).toMatchObject({
      model: 'tiny',
      max_tokens: 123,
      system: 'be brief',
      messages: [{ role: 'user', content: 'hello' }],
    })
  })

  it('a reply with only tool calls has no text and is an error', async () => {
    const m = await mock()
    m.script({ toolCalls: [{ name: 'x', arguments: {} }] })
    const p = createProvider(settings(m, { provider: 'anthropic', base_url: m.url }), { env })
    await expect(p.complete(req)).rejects.toThrow(/no text/)
  })
})

describe('factory', () => {
  it('builds none and fake, rejects unknown providers', async () => {
    const m = await mock()
    expect(createProvider(settings(m, { provider: 'none' })).name).toBe('none')
    await expect(
      createProvider(settings(m, { provider: 'none' })).complete(req),
    ).rejects.toBeInstanceOf(LLMError)
    expect(createProvider(settings(m, { provider: 'fake' })).name).toBe('fake')
    expect(() => createProvider(settings(m, { provider: 'gemini' }))).toThrow(
      /unknown llm provider/,
    )
  })
})

describe.each([
  ['openai-compatible', (m: MockLlm) => settings(m, {})],
  ['anthropic', (m: MockLlm) => settings(m, { provider: 'anthropic', base_url: m.url })],
])('condenser over %s', (_name, mk) => {
  it('turns a fenced JSON reply into summary and proposals', async () => {
    const m = await mock()
    const out = {
      summary: 'User wants cents.',
      proposals: [{ kind: 'thread', payload: { title: 'Rounding' } }],
    }
    m.script({ text: `\`\`\`json\n${JSON.stringify(out)}\n\`\`\`` })
    const c = new Condenser(createProvider(mk(m), { env }), estimatorTokenizer)
    const r = await c.run({
      previous: '',
      turns: [{ role: 'user', content: 'use cents' }],
      envelope: '<hafiz>…</hafiz>',
      focus: ['blk_a'],
      capTokens: 1500,
    })
    expect(r.summary).toBe('User wants cents.')
    expect(r.proposals).toHaveLength(1)
    expect(r.usage?.inputTokens).toBeGreaterThan(0)
    expect(JSON.stringify(m.requests[0]?.body)).toContain('ALREADY COVERED')
  })
})
