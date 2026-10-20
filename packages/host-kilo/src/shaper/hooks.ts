// transform-hooks: the same shaping through Kilo's experimental hooks, no network hop.
//   experimental.chat.system.transform   → envelope + floor pushed as one extra system entry
//                                          (Kilo joins entries after the first into system[1])
//   experimental.chat.messages.transform → stubbed tool outputs, inserted unfiled/delta messages
// Kilo's internal message model: tool results live in assistant messages as `tool` parts.
import type { Turn } from '@hafiz/core'
import type { KiloMessageWithParts, KiloPart } from '../kilo.js'
import { type ConversationShaper, isInserted } from './core.js'
import type { RequestShaper } from './types.js'

export interface HooksRequest {
  sessionId: string
  model?: string | undefined
  /** Present for the system transform. */
  system?: string[]
  /** Present for the messages transform. */
  messages?: KiloMessageWithParts[]
}

const textOf = (parts: KiloPart[]) =>
  parts
    .filter((p) => p.type === 'text' && !p.ignored && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')

export function kiloToTurns(messages: KiloMessageWithParts[]): Turn[] {
  const turns: Turn[] = []
  messages.forEach((m, i) => {
    if (m.info.role === 'user') {
      turns.push({ role: 'user', content: textOf(m.parts), id: `u${i}` })
      return
    }
    turns.push({ role: 'assistant', content: textOf(m.parts), id: `a${i}` })
    m.parts.forEach((p, j) => {
      if (p.type === 'tool' && p.state?.status === 'completed')
        turns.push({
          role: 'tool',
          content: String(p.state.output ?? ''),
          toolName: p.tool ?? 'tool',
          id: `t${i}.${j}`,
        })
    })
  })
  return turns
}

export class TransformHooksShaper implements RequestShaper<HooksRequest> {
  readonly kind = 'transform-hooks' as const
  /** Sessions the hooks fired for; the proxy stays out of their requests. */
  readonly seen = new Set<string>()

  constructor(
    private readonly shaper: ConversationShaper,
    private readonly log?: (line: string) => void,
  ) {}

  async shape(req: HooksRequest): Promise<HooksRequest> {
    if (!this.shaper.isManaged(req.sessionId)) return req
    this.seen.add(req.sessionId)
    try {
      if (req.system) return { ...req, system: await this.shapeSystem(req) }
      if (req.messages) return { ...req, messages: await this.shapeMessages(req) }
    } catch (e) {
      this.log?.(`hafiz hooks: shaping failed, passing through: ${String(e)}`)
    }
    return req
  }

  private async shapeSystem(req: HooksRequest): Promise<string[]> {
    const system = req.system as string[]
    const shaped = await this.shaper.shape({
      sessionId: req.sessionId,
      model: req.model,
      conversation: { system: system.join('\n'), turns: [] },
      parts: { system: true, tail: false },
    })
    return shaped?.systemAddition ? [...system, shaped.systemAddition] : system
  }

  private async shapeMessages(req: HooksRequest): Promise<KiloMessageWithParts[]> {
    const messages = req.messages as KiloMessageWithParts[]
    const turns = kiloToTurns(messages)
    const shaped = await this.shaper.shape({
      sessionId: req.sessionId,
      model: req.model,
      conversation: { system: '', turns },
      parts: { system: false, tail: true },
    })
    if (!shaped) return messages
    const stub = new Map<string, string>()
    for (const t of shaped.turns)
      if (t.id && shaped.stubbed.includes(t.id)) stub.set(t.id, t.content)
    const out: KiloMessageWithParts[] = []
    const emitted = new Set<number>()
    let n = 0
    shaped.turns.forEach((t, k) => {
      if (isInserted(t)) {
        const next = shaped.turns.slice(k + 1).find((x) => !isInserted(x))
        const at = next ? Number(/^\D(\d+)/.exec(next.id as string)?.[1]) : messages.length - 1
        const cand = messages[at]
        const near =
          cand?.info.role === 'user' ? cand : messages.find((x) => x.info.role === 'user')
        out.push(synthetic(near ?? (messages[0] as KiloMessageWithParts), t, n++))
        return
      }
      const i = Number(/^\D(\d+)/.exec(t.id as string)?.[1])
      if (emitted.has(i)) return
      emitted.add(i)
      const m = messages[i] as KiloMessageWithParts
      const parts = m.parts.map((p, j) => {
        const s = stub.get(`t${i}.${j}`)
        return s !== undefined && p.state ? { ...p, state: { ...p.state, output: s } } : p
      })
      out.push(parts.some((p, j) => p !== m.parts[j]) ? { ...m, parts } : m)
    })
    return out
  }
}

/** A user message carrying one inserted turn, modelled on a neighbouring message. */
function synthetic(near: KiloMessageWithParts, t: Turn, n: number): KiloMessageWithParts {
  const id = `${near.info.id}_${t.id}_${n}`
  return {
    info: { ...near.info, id, role: 'user' },
    parts: [
      {
        id: `${id}_p`,
        sessionID: near.info.sessionID,
        messageID: id,
        type: 'text',
        text: t.content,
        synthetic: true,
      },
    ],
  }
}
