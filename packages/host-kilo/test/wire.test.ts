import { describe, expect, it } from 'vitest'
import { EmbeddedProxy, SESSION_HEADER } from '../src/index.js'
import { configWith, ENVELOPE, FLOOR, fakeSource, fixture, shaperFor } from './helpers.js'

// biome-ignore lint/suspicious/noExplicitAny: wire JSON is navigated freely in assertions
type Json = Record<string, any>

function proxyWith(source = fakeSource(), config = configWith()) {
  return new EmbeddedProxy({ shaper: shaperFor(source, config) })
}

async function shapeRaw(
  proxy: EmbeddedProxy,
  path: string,
  raw: string,
  session = 's1',
): Promise<string> {
  const r = await proxy.shape({
    path,
    headers: { [SESSION_HEADER]: session, authorization: 'Bearer x' },
    body: Buffer.from(raw),
  })
  return r.body.toString('utf8')
}

const OA = '/chat/completions'
const AN = '/messages'

describe('OpenAI Chat Completions adapter', () => {
  const raw = fixture('openai-chat.json')
  const input = JSON.parse(raw) as Json

  it('changes only the system envelope when no tail work is due, with stable bytes', async () => {
    const proxy = proxyWith()
    const a = await shapeRaw(proxy, OA, raw)
    const b = await shapeRaw(proxy, OA, raw)
    expect(a).toBe(b)
    const out = JSON.parse(a) as Json
    // the envelope is one system message after the host's two
    expect(out.messages[2]).toEqual({ role: 'system', content: `${ENVELOPE}\n\n${FLOOR}` })
    out.messages.splice(2, 1)
    expect(JSON.stringify(out)).toBe(raw)
  })

  it('stubs old tool results only; user turns, newest turn and unknown fields survive', async () => {
    const proxy = proxyWith(fakeSource(), configWith({ tool_result_max_age_turns: 1 }))
    const out = JSON.parse(await shapeRaw(proxy, OA, raw)) as Json
    const msgs = out.messages.filter(
      (m: Json) => !(m.role === 'system' && m.content === `${ENVELOPE}\n\n${FLOOR}`),
    )
    expect(msgs).toHaveLength(input.messages.length)
    const tools = msgs.filter((m: Json) => m.role === 'tool')
    expect(tools[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_0',
      content: expect.stringMatching(/^\[elided: [\d.]+k? tokens — read\]$/),
    })
    expect(tools[1].content).toMatch(/^\[elided: .* — bash\]$/)
    expect(tools[2]).toEqual(input.messages.find((m: Json) => m.tool_call_id === 'call_2'))
    expect(msgs.at(-1)).toEqual(input.messages.at(-1)) // newest turn untouched
    msgs.forEach((m: Json, i: number) => {
      if (m.role !== 'tool') expect(m).toEqual(input.messages[i]) // users, assistants, systems
    })
    expect(out.x_vendor_extension).toEqual(input.x_vendor_extension)
    expect(out.tools).toEqual(input.tools)
    expect(Object.keys(out)).toEqual(Object.keys(input))
  })

  it('inserts unfiled first and the delta before the newest user turn, then keeps it there', async () => {
    const src = fakeSource({
      deltas: ['<hafiz-delta>\n- found: rounding happens twice\n</hafiz-delta>'],
      unfiled: 'User wants cents.',
    })
    const proxy = proxyWith(src)
    const out1 = JSON.parse(await shapeRaw(proxy, OA, raw)) as Json
    const lastUser = input.messages.findLastIndex((m: Json) => m.role === 'user')
    // [sys, sys, envelope, unfiled, …]
    expect(out1.messages[3].content).toContain('<hafiz-unfiled>')
    const di = out1.messages.findIndex((m: Json) => String(m.content).includes('<hafiz-delta>'))
    expect(out1.messages[di + 1]).toEqual(input.messages[lastUser])
    // next request: two more turns appended; no new delta → the old one is re-inserted in place
    const next = {
      ...input,
      messages: [
        ...input.messages,
        { role: 'assistant', content: 'Fixed.' },
        { role: 'user', content: [{ type: 'text', text: 'Thanks, now refunds.' }] },
      ],
    }
    const out2 = JSON.parse(await shapeRaw(proxy, OA, JSON.stringify(next))) as Json
    expect(out2.messages.slice(0, out1.messages.length)).toEqual(out1.messages)
  })

  it('passes unknown sessions through byte for byte', async () => {
    const proxy = proxyWith()
    expect(await shapeRaw(proxy, OA, raw, 'other')).toBe(raw)
  })
})

describe('Anthropic Messages adapter', () => {
  const raw = fixture('anthropic-messages.json')
  const input = JSON.parse(raw) as Json

  it('changes only the system envelope when no tail work is due, with stable bytes', async () => {
    const proxy = proxyWith()
    const a = await shapeRaw(proxy, AN, raw)
    expect(await shapeRaw(proxy, AN, raw)).toBe(a)
    const out = JSON.parse(a) as Json
    expect(out.system).toHaveLength(3)
    expect(out.system.slice(0, 2)).toEqual(input.system) // cache_control kept
    expect(out.system[2]).toEqual({ type: 'text', text: `${ENVELOPE}\n\n${FLOOR}` })
    out.system.pop()
    expect(JSON.stringify(out)).toBe(raw)
  })

  it('stubs old tool_result blocks keeping ids, flags and cache_control', async () => {
    const proxy = proxyWith(fakeSource(), configWith({ tool_result_max_age_turns: 1 }))
    const out = JSON.parse(await shapeRaw(proxy, AN, raw)) as Json
    expect(out.messages).toHaveLength(input.messages.length)
    const results = out.messages.flatMap((m: Json) =>
      Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === 'tool_result') : [],
    )
    expect(results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'toolu_0',
      content: expect.stringMatching(/^\[elided: .* — read\]$/),
    })
    expect(results[1]).toMatchObject({ tool_use_id: 'toolu_1', is_error: true })
    expect(results[1].content).toMatch(/— bash\]$/)
    const orig = input.messages.flatMap((m: Json) =>
      Array.isArray(m.content) ? m.content.filter((b: Json) => b.type === 'tool_result') : [],
    )
    expect(results[2]).toEqual(orig[2])
    expect(results[3]).toEqual(orig[3]) // newest turn, with cache_control
    out.messages.forEach((m: Json, i: number) => {
      const isResult = Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      if (!isResult) expect(m).toEqual(input.messages[i]) // thinking signatures, users intact
    })
    expect(out.thinking).toEqual(input.thinking)
    expect(out.metadata).toEqual(input.metadata)
    expect(out.tools).toEqual(input.tools)
  })

  it('inserts unfiled and delta as user messages and appends to a string system', async () => {
    const proxy = proxyWith(
      fakeSource({ deltas: ['<hafiz-delta>\n- x\n</hafiz-delta>'], unfiled: 'u' }),
    )
    const body = { ...input, system: 'You are Kilo.' }
    const out = JSON.parse(await shapeRaw(proxy, AN, JSON.stringify(body))) as Json
    expect(out.system).toBe(`You are Kilo.\n\n${ENVELOPE}\n\n${FLOOR}`)
    expect(out.messages[0].content[0].text).toContain('<hafiz-unfiled>')
    const lastUser = input.messages.findLastIndex(
      (m: Json) => m.role === 'user' && m.content[0]?.type === 'text',
    )
    const di = out.messages.findIndex((m: Json) => m.content[0]?.text?.includes('<hafiz-delta>'))
    expect(out.messages[di + 1]).toEqual(input.messages[lastUser])
    expect(out.messages.length).toBe(input.messages.length + 2)
  })
})
