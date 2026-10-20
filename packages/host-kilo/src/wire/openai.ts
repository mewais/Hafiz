// OpenAI Chat Completions ⇄ core Conversation. Only three things ever change on the wire: an
// extra system message (envelope + floor) after the host's leading system messages, the content
// of stubbed tool messages, and inserted user messages (unfiled, delta). Every other message
// object is passed through as the very same object, so unknown fields survive verbatim.
import type { Conversation, Turn } from '@hafiz/core'
import { isInserted, type Shaped } from '../shaper/core.js'

type Json = Record<string, unknown>

export interface OpenAiParsed {
  conversation: Conversation
  /** Number of leading system/developer messages. */
  lead: number
}

const isSystem = (m: Json) => m.role === 'system' || m.role === 'developer'

/** Text of a content field for counting; non-text parts are counted by their JSON. */
export function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (c == null) return ''
  if (Array.isArray(c))
    return c
      .map((p) =>
        p && typeof p === 'object' && typeof (p as Json).text === 'string'
          ? ((p as Json).text as string)
          : JSON.stringify(p),
      )
      .join('\n')
  return JSON.stringify(c)
}

export function isChatCompletions(body: unknown): body is Json & { messages: Json[] } {
  return !!body && typeof body === 'object' && Array.isArray((body as Json).messages)
}

export function parseOpenAi(body: Json & { messages: Json[] }): OpenAiParsed {
  const msgs = body.messages
  let lead = 0
  while (lead < msgs.length && isSystem(msgs[lead] as Json)) lead++
  const names = new Map<string, string>()
  for (const m of msgs)
    for (const c of (m.tool_calls as Json[] | undefined) ?? []) {
      const fn = c.function as Json | undefined
      if (typeof c.id === 'string' && typeof fn?.name === 'string') names.set(c.id, fn.name)
    }
  const turns: Turn[] = []
  for (let i = lead; i < msgs.length; i++) {
    const m = msgs[i] as Json
    const content = contentText(m.content)
    const id = `m${i}`
    if (m.role === 'user') turns.push({ role: 'user', content, id })
    else if (m.role === 'tool' || m.role === 'function') {
      const name =
        (typeof m.tool_call_id === 'string' ? names.get(m.tool_call_id) : undefined) ??
        (typeof m.name === 'string' ? m.name : 'tool')
      turns.push({ role: 'tool', content, toolName: name, id })
    } else turns.push({ role: 'assistant', content, id })
  }
  return {
    conversation: {
      system: msgs
        .slice(0, lead)
        .map((m) => contentText(m.content))
        .join('\n\n'),
      turns,
    },
    lead,
  }
}

export function applyOpenAi(
  body: Json & { messages: Json[] },
  parsed: OpenAiParsed,
  shaped: Shaped,
): Json {
  const msgs = body.messages
  const stubbed = new Set(shaped.stubbed)
  const out: Json[] = msgs.slice(0, parsed.lead)
  if (shaped.systemAddition) out.push({ role: 'system', content: shaped.systemAddition })
  for (const t of shaped.turns) {
    if (isInserted(t)) {
      out.push({ role: 'user', content: t.content })
      continue
    }
    const i = Number(t.id?.slice(1))
    const m = msgs[i] as Json
    out.push(stubbed.has(t.id as string) ? { ...m, content: t.content } : m)
  }
  return { ...body, messages: out }
}
