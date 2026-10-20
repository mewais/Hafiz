// Replays a task's `mock:` script on the mock LLM (--mock mode). A request is matched to its
// script by (turn, role): the turn from a `[[turn:N]]` marker in the last user message (the
// runner appends it to every prompt; scripted task prompts carry it on to subagents), the role
// from the `<hafiz … role="x">` envelope in the system prompt. The step is the number of
// assistant messages since that user message, so a session simply walks its step list.
import type { RecordedRequest, ScriptedReply } from './mock-llm.js'
import type { MockStep, Task } from './tasks.js'

type Msg = {
  role: string
  content?: unknown
  tool_calls?: Array<{ id: string; function?: { name?: string } }>
  tool_call_id?: string
}
type Body = { messages?: Msg[]; tools?: unknown[] }

export const TURN_MARKER = (n: number) => `[[turn:${n}]]`

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c
          .map((p) =>
            p && typeof p === 'object' ? String((p as { text?: unknown }).text ?? '') : '',
          )
          .join('\n')
      : ''

export interface ScriptContext {
  /** The temp repo (`{repo}`). */
  repo: string
  /** Block ids by name (`{b.name}`); seeded blocks first, saved tool results added as the run goes. */
  vars: Record<string, string>
}

const WORKER_DONE = 'Finished the assigned block.\n```hafiz-report\noutcome: done\n```'

export function scriptResponder(
  task: Task,
  ctx: ScriptContext,
): (req: RecordedRequest) => ScriptedReply {
  const pending = new Map<string, string>() // tool call id -> variable name
  let seq = 0
  const fill = (v: unknown, extra: Record<string, string>): unknown => {
    if (typeof v === 'string')
      return v.replace(/\{(b\.[\w-]+|repo|turn|block)\}/g, (all, k: string) => {
        if (k === 'repo') return ctx.repo
        if (k.startsWith('b.')) return ctx.vars[k.slice(2)] ?? all
        return extra[k] ?? all
      })
    if (Array.isArray(v)) return v.map((x) => fill(x, extra))
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, extra)]))
    return v
  }

  return (req) => {
    const body = (req.body ?? {}) as Body
    const messages = body.messages ?? []
    // title/summary calls carry no tools
    if (!body.tools?.length) return { text: 'Session' }

    // learn the ids of results to earlier `as:` calls
    for (const m of messages) {
      const name = m.role === 'tool' && m.tool_call_id ? pending.get(m.tool_call_id) : undefined
      if (!name || !m.tool_call_id) continue
      try {
        const id = (JSON.parse(textOf(m.content).split('\n')[0] ?? '') as { id?: unknown }).id
        if (typeof id === 'string') ctx.vars[name] = id
        pending.delete(m.tool_call_id)
      } catch {}
    }

    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('\n')
    const role = /<hafiz hash="[0-9a-f]+" role="(\w+)">/.exec(system)?.[1] ?? 'manager'
    let lastUser = -1
    for (let i = messages.length - 1; i >= 0; i--)
      if (messages[i]?.role === 'user') {
        lastUser = i
        break
      }
    const prompt = textOf(messages[lastUser]?.content)
    const turn = Number(/\[\[turn:(\d+)\]\]/.exec(prompt)?.[1] ?? 1)
    const index = messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').length
    const extra = {
      turn: String(turn),
      block: /hafiz:block=([\w-]+)/.exec(prompt)?.[1] ?? '',
    }

    const steps: MockStep[] = task.mock.find((t) => t.turn === turn)?.roles[role] ?? []
    const step = steps[index]
    const usage = { input: 400, output: 60, cacheRead: index === 0 ? 0 : 1600 }
    if (!step) return { text: role === 'worker' ? WORKER_DONE : 'Done.', usage }
    const toolCalls = (step.calls ?? []).map((c) => {
      const id = `call_h${++seq}`
      if (c.as) pending.set(id, c.as)
      return { id, name: c.tool, arguments: fill(c.args, extra) as Record<string, unknown> }
    })
    return {
      ...(step.text !== undefined ? { text: fill(step.text, extra) as string } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
      usage,
    }
  }
}
