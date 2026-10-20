// Anthropic Messages ⇄ core Conversation. A user message carrying tool_result blocks maps to one
// `tool` turn per block (so the newest real user turn is never a tool result); any other user
// message is one `user` turn. Changes on the wire: one text block appended to `system`, stubbed
// tool_result `content` (tool_use_id, is_error, cache_control kept), inserted user messages.
import type { Conversation, Turn } from '@hafiz/core'
import { isInserted, type Shaped } from '../shaper/core.js'
import { contentText } from './openai.js'

type Json = Record<string, unknown>

export interface AnthropicParsed {
  conversation: Conversation
}

export function isMessages(body: unknown): body is Json & { messages: Json[] } {
  return !!body && typeof body === 'object' && Array.isArray((body as Json).messages)
}

function blocks(m: Json): Json[] | null {
  return Array.isArray(m.content) ? (m.content as Json[]) : null
}

export function parseAnthropic(body: Json & { messages: Json[] }): AnthropicParsed {
  const names = new Map<string, string>()
  for (const m of body.messages)
    for (const b of blocks(m) ?? [])
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string')
        names.set(b.id, b.name)
  const turns: Turn[] = []
  body.messages.forEach((m, i) => {
    const bs = blocks(m)
    if (m.role === 'user' && bs?.some((b) => b.type === 'tool_result')) {
      bs.forEach((b, j) => {
        if (b.type !== 'tool_result') return
        turns.push({
          role: 'tool',
          content: contentText(b.content),
          toolName: (typeof b.tool_use_id === 'string' && names.get(b.tool_use_id)) || 'tool',
          id: `m${i}.b${j}`,
        })
      })
    } else
      turns.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: contentText(m.content),
        id: `m${i}`,
      })
  })
  return { conversation: { system: contentText(body.system), turns } }
}

function locate(id: string): { msg: number; block?: number } {
  const [m, b] = id.split('.')
  return b ? { msg: Number(m?.slice(1)), block: Number(b.slice(1)) } : { msg: Number(m?.slice(1)) }
}

export function applyAnthropic(body: Json & { messages: Json[] }, shaped: Shaped): Json {
  const msgs = body.messages
  // stubbed content per message index → block index
  const stubs = new Map<number, Map<number, string>>()
  const stubbed = new Set(shaped.stubbed)
  for (const t of shaped.turns) {
    if (isInserted(t) || !stubbed.has(t.id as string)) continue
    const { msg, block } = locate(t.id as string)
    if (block === undefined) continue
    const s = stubs.get(msg) ?? new Map<number, string>()
    s.set(block, t.content)
    stubs.set(msg, s)
  }
  const out: Json[] = []
  const emitted = new Set<number>()
  for (const t of shaped.turns) {
    if (isInserted(t)) {
      out.push({ role: 'user', content: [{ type: 'text', text: t.content }] })
      continue
    }
    const { msg } = locate(t.id as string)
    if (emitted.has(msg)) continue
    emitted.add(msg)
    const m = msgs[msg] as Json
    const s = stubs.get(msg)
    out.push(
      s
        ? {
            ...m,
            content: (blocks(m) as Json[]).map((b, j) =>
              s.has(j) ? { ...b, content: s.get(j) } : b,
            ),
          }
        : m,
    )
  }
  const result: Json = { ...body, messages: out }
  const add = shaped.systemAddition
  if (add) {
    const sys = body.system
    if (Array.isArray(sys)) result.system = [...sys, { type: 'text', text: add }]
    else if (typeof sys === 'string' && sys) result.system = `${sys}\n\n${add}`
    else result.system = add
  }
  return result
}
