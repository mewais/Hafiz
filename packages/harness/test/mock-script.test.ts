import { loadConfig, toolsForRole } from '@hafiz/core'
import { describe, expect, it } from 'vitest'
import type { RecordedRequest } from '../src/mock-llm.js'
import { scriptResponder, TURN_MARKER } from '../src/mock-script.js'
import { loadTasks, parseTask } from '../src/tasks.js'

const task = parseTask(`
id: t
size: M
description: d
turns: [{ prompt: p }]
mock:
  - turn: 1
    roles:
      manager:
        - calls: [{ tool: hafiz_block_create, as: kid, args: { parent: "{b.root}", title: Kid } }]
        - calls: [{ tool: task, args: { prompt: "hafiz:block={b.kid} [[turn:{turn}]] go {repo}" } }]
        - text: all done
      worker:
        - calls: [{ tool: hafiz_progress_append, args: { block: "{block}", kind: found, text: x } }]
`)

const req = (messages: unknown[], tools = true): RecordedRequest => ({
  method: 'POST',
  path: '/v1/chat/completions',
  headers: {},
  raw: '',
  body: { messages, ...(tools ? { tools: [{}] } : {}) },
})
const sys = (role: string) => ({
  role: 'system',
  content: `<hafiz hash="0123456789ab" role="${role}">x</hafiz>`,
})
const user = (text: string) => ({ role: 'user', content: `${text}\n\n${TURN_MARKER(1)}` })

describe('scriptResponder', () => {
  it('walks a role script by assistant message, learns saved ids from tool results', () => {
    const respond = scriptResponder(task, { repo: '/r', vars: { root: 'blk_root' } })
    const first = respond(req([sys('manager'), user('hi')]))
    expect(first.toolCalls?.[0]).toMatchObject({
      name: 'hafiz_block_create',
      arguments: { parent: 'blk_root', title: 'Kid' },
    })
    const id = first.toolCalls?.[0]?.id as string
    const history = [
      sys('manager'),
      user('hi'),
      { role: 'assistant', tool_calls: [{ id }] },
      { role: 'tool', tool_call_id: id, content: '{"id":"kid-1234"}\ninfo: x' },
    ]
    const second = respond(req(history))
    expect(second.toolCalls?.[0]?.arguments.prompt).toBe('hafiz:block=kid-1234 [[turn:1]] go /r')
    const third = respond(
      req([
        ...history,
        { role: 'assistant', tool_calls: [{ id: 'z' }] },
        { role: 'tool', tool_call_id: 'z', content: 'ok' },
      ]),
    )
    expect(third).toMatchObject({ text: 'all done' })
  })

  it('serves a worker its block from the spawn prompt; unscripted steps finish; title calls get a title', () => {
    const respond = scriptResponder(task, { repo: '/r', vars: {} })
    const w = respond(req([sys('worker'), user('hafiz:block=kid-9 do it')]))
    expect(w.toolCalls?.[0]?.arguments.block).toBe('kid-9')
    const done = respond(
      req([
        sys('worker'),
        user('hafiz:block=kid-9'),
        { role: 'assistant' },
        { role: 'tool', content: '' },
      ]),
    )
    expect(done.text).toContain('hafiz-report')
    expect(respond(req([sys('manager'), user('t')], false)).text).toBe('Session')
  })
})

describe('the task set', () => {
  it('scripts each role with tools that role has', () => {
    const config = loadConfig()
    const host = new Set(['task', 'write', 'edit', 'bash', 'read'])
    for (const t of loadTasks())
      for (const turn of t.mock)
        for (const [role, steps] of Object.entries(turn.roles)) {
          const allowed = new Set(toolsForRole(config, role, 'kilo').map((x) => x.spec.name))
          for (const s of steps)
            for (const c of 'calls' in s ? (s.calls ?? []) : [])
              expect(host.has(c.tool) || allowed.has(c.tool), `${t.id} ${role}: ${c.tool}`).toBe(
                true,
              )
        }
  })
})
