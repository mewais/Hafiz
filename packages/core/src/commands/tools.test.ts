// The agent tool catalogue: which tools each role sees, narrowed how, and which command every
// tool call (and every action of it) runs.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { ValidationError } from '../domain/errors.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { COMMAND_SPECS } from './catalogue.js'
import { type RoleTool, routeTool, TOOL_SPECS, toolsForRole, toolTokens } from './tools.js'

const config = loadConfig()
const tool = (role: string, name: string, host?: 'kilo' | 'mcp'): RoleTool => {
  const t = toolsForRole(config, role, host).find((x) => x.spec.name === name)
  if (!t) throw new Error(`${role} has no ${name}`)
  return t
}
const route = (role: string, name: string, args: Record<string, unknown>) =>
  routeTool(tool(role, name), args)
const props = (t: RoleTool) => Object.keys(t.spec.shape(config, t))

const digest = { outcome: 'x', interface_delta: ['none'], pointers: [] }

// [role, tool, args, command, Core args]: every tool, every action.
const CASES: Array<[string, string, Record<string, unknown>, string, Record<string, unknown>]> = [
  ['user', 'hafiz_context_for', { budget_tokens: 9 }, 'context.for', { budgetTokens: 9 }],
  ['user', 'hafiz_context_delta', {}, 'context.delta', {}],
  ['user', 'hafiz_session_status', {}, 'session.status', {}],
  ['manager', 'hafiz_block_read', {}, 'tree.list', {}],
  [
    'manager',
    'hafiz_block_read',
    { id: 'b', zoom: 'DESIGN' },
    'block.read',
    { id: 'b', zoom: 'DESIGN' },
  ],
  ['manager', 'hafiz_block_read', { id: 'b', explain: true }, 'context.explain', { block: 'b' }],
  [
    'planner',
    'hafiz_block_create',
    { parent: 'r', title: 'T', plan: {} },
    'block.create',
    { parent: 'r', title: 'T', plan: {} },
  ],
  [
    'manager',
    'hafiz_block_edit',
    { id: 'b', title: 'T', order: 2 },
    'block.update',
    { id: 'b', title: 'T', order: 2 },
  ],
  [
    'manager',
    'hafiz_block_edit',
    { id: 'b', parent: 'p' },
    'block.move',
    { id: 'b', newParent: 'p' },
  ],
  [
    'manager',
    'hafiz_block_set_status',
    { id: 'b', status: 'done', digest, confirmed: true },
    'block.set_status',
    { id: 'b', status: 'done', digest, confirmed: true },
  ],
  [
    'manager',
    'hafiz_block_set_status',
    { id: 'b', status: 'blocked', blocked_on: 'block:auth' },
    'block.set_status',
    { id: 'b', status: 'blocked', blockedOn: { kind: 'block', ref: 'auth' } },
  ],
  [
    'manager',
    'hafiz_block_set_status',
    { id: 'b', status: 'blocked', blocked_on: 'external:Stripe review' },
    'block.set_status',
    { id: 'b', status: 'blocked', blockedOn: { kind: 'external', note: 'Stripe review' } },
  ],
  [
    'manager',
    'hafiz_block_set_status',
    { id: 'b', status: 'dropped', reason: 'r' },
    'block.set_status',
    { id: 'b', status: 'dropped', reason: 'r' },
  ],
  [
    'worker',
    'hafiz_block_set_status',
    { id: 'b', status: 'done', digest },
    'block.request_done',
    { id: 'b', digest },
  ],
  [
    'designer',
    'hafiz_doc',
    { block: 'b', type: 'design', sections: {}, expected_version: 2 },
    'doc.patch',
    { block: 'b', type: 'design', sections: {}, expectedVersion: 2, requireVersion: true },
  ],
  [
    'designer',
    'hafiz_doc',
    { block: 'b', type: 'design', sections: {}, replace: true },
    'doc.write',
    { block: 'b', type: 'design', sections: {}, requireVersion: true },
  ],
  [
    'worker',
    'hafiz_progress_append',
    { block: 'b', kind: 'done', text: 't', step: { id: 's1', status: 'done' } },
    'progress.append',
    { block: 'b', kind: 'done', text: 't', step: { id: 's1', status: 'done' } },
  ],
  [
    'worker',
    'hafiz_progress_append',
    { block: 'b', kind: 'found', text: 't', refs: ['f'] },
    'progress.append',
    { block: 'b', kind: 'found', text: 't', refs: ['f'] },
  ],
  [
    'manager',
    'hafiz_decision_record',
    { block: 'b', title: 'T', decision: 'D', standing: 'always' },
    'decision.record',
    { block: 'b', title: 'T', decision: 'D', standing: 'always' },
  ],
  [
    'manager',
    'hafiz_thread',
    { action: 'open', block: 'b', title: 'T', text: 'x', gist: 'ignored' },
    'thread.open',
    { block: 'b', title: 'T', text: 'x' },
  ],
  [
    'manager',
    'hafiz_thread',
    { action: 'append', id: 't', text: 'x' },
    'thread.append',
    { id: 't', text: 'x' },
  ],
  [
    'manager',
    'hafiz_thread',
    { action: 'park', id: 't', gist: 'g' },
    'thread.park',
    { id: 't', gist: 'g' },
  ],
  ['manager', 'hafiz_thread', { action: 'park', id: 't' }, 'thread.park', { id: 't' }],
  ['manager', 'hafiz_thread', { action: 'resume', id: 't' }, 'thread.resume', { id: 't' }],
  [
    'manager',
    'hafiz_thread',
    { action: 'resolve', id: 't', outcome: 'o' },
    'thread.resolve',
    { id: 't', outcome: 'o' },
  ],
  [
    'manager',
    'hafiz_review',
    { action: 'list' },
    'review.list',
    { status: 'pending', resolvable: true },
  ],
  ['manager', 'hafiz_review', { action: 'accept', id: 'p' }, 'proposal.accept', { id: 'p' }],
  ['manager', 'hafiz_review', { action: 'reject', id: 'p' }, 'proposal.reject', { id: 'p' }],
]

describe('tool catalogue → commands', () => {
  it.each(CASES)('%s %s %j → %s', (role, name, args, command, coreArgs) => {
    expect(route(role, name, args)).toEqual({ command, args: coreArgs })
  })

  it('covers every command each tool declares, and only catalogue commands', () => {
    // the review list is the read that `proposal.list` grants
    const reached = new Set(CASES.map((c) => (c[3] === 'review.list' ? 'proposal.list' : c[3])))
    const commands = new Set(COMMAND_SPECS.map((c) => c.command))
    for (const s of TOOL_SPECS)
      for (const c of s.commands) {
        expect(reached.has(c), `${s.name} → ${c} untested`).toBe(true)
        expect(commands.has(c), `${c} is not a command`).toBe(true)
      }
    expect(new Set(CASES.map((c) => c[1]))).toEqual(new Set(TOOL_SPECS.map((s) => s.name)))
  })

  it('rejects calls that do not fit the tool before anything runs', () => {
    const bad: Array<[string, string, Record<string, unknown>, RegExp]> = [
      ['manager', 'hafiz_block_edit', { id: 'b', parent: 'p', title: 'T' }, /call of its own/],
      ['manager', 'hafiz_block_edit', { id: 'b' }, /nothing to change/],
      ['worker', 'hafiz_block_set_status', { id: 'b', status: 'done' }, /done needs digest/],
      [
        'manager',
        'hafiz_block_set_status',
        { id: 'b', status: 'blocked', blocked_on: 'soon' },
        /blocked_on/,
      ],
      ['manager', 'hafiz_thread', { action: 'open', block: 'b' }, /thread open needs title/],
      ['manager', 'hafiz_thread', { action: 'append', id: 't' }, /needs text/],
      ['manager', 'hafiz_review', { action: 'accept' }, /review accept needs id/],
    ]
    for (const [role, name, args, msg] of bad) {
      const e = (() => {
        try {
          route(role, name, args)
        } catch (x) {
          return x
        }
      })()
      expect(e, `${name} ${JSON.stringify(args)}`).toBeInstanceOf(ValidationError)
      expect((e as Error).message).toMatch(msg)
    }
  })
})

describe('tool catalogue per role', () => {
  const names = (role: string, host?: 'kilo' | 'mcp') =>
    toolsForRole(config, role, host).map((t) => t.spec.name)

  it('gives each role its tools; Kilo leaves out the context reads it injects', () => {
    const common = ['hafiz_context_for', 'hafiz_context_delta']
    expect(names('manager', 'kilo')).toEqual([
      'hafiz_block_read',
      'hafiz_block_create',
      'hafiz_block_edit',
      'hafiz_block_set_status',
      'hafiz_doc',
      'hafiz_progress_append',
      'hafiz_decision_record',
      'hafiz_thread',
      'hafiz_review',
    ])
    expect(names('manager', 'mcp')).toEqual([
      ...common,
      'hafiz_session_status',
      ...names('manager', 'kilo'),
    ])
    expect(names('designer', 'kilo')).toEqual([
      'hafiz_block_read',
      'hafiz_block_create',
      'hafiz_doc',
      'hafiz_progress_append',
      'hafiz_decision_record',
      'hafiz_thread',
    ])
    expect(names('planner', 'kilo')).toEqual([
      'hafiz_block_read',
      'hafiz_block_create',
      'hafiz_doc',
      'hafiz_thread',
    ])
    expect(names('worker', 'kilo')).toEqual([
      'hafiz_block_read',
      'hafiz_block_set_status',
      'hafiz_progress_append',
      'hafiz_thread',
    ])
    expect(names('worker', 'mcp')).toEqual([...common, ...names('worker', 'kilo')])
    expect(names('user')).toEqual(TOOL_SPECS.map((s) => s.name))
    expect(names('viewer', 'kilo')).toEqual(['hafiz_block_read', 'hafiz_review'])
  })

  it('narrows enums and inputs to the role allowlist', () => {
    const w = tool('worker', 'hafiz_block_set_status')
    expect(w.choices).toEqual(['done'])
    expect(props(w)).toEqual(['id', 'status', 'digest'])
    expect(w.spec.description(config, w)).toMatch(/done is a request/)
    const m = tool('manager', 'hafiz_block_set_status')
    expect(m.choices).toEqual(['planned', 'active', 'blocked', 'done', 'dropped'])
    expect(props(m)).toContain('confirmed')
    expect(m.spec.description(config, m)).not.toMatch(/request/)

    expect(tool('worker', 'hafiz_thread').choices).toEqual(['open', 'park'])
    expect(props(tool('worker', 'hafiz_thread'))).toEqual([
      'action',
      'block',
      'title',
      'id',
      'text',
      'gist',
    ])
    expect(tool('planner', 'hafiz_thread').choices).toEqual([
      'open',
      'append',
      'park',
      'resume',
      'resolve',
    ])

    const mdoc = tool('manager', 'hafiz_doc')
    expect(mdoc.choices).toEqual(['plan'])
    expect(props(mdoc)).not.toContain('replace')
    const ddoc = tool('designer', 'hafiz_doc')
    expect(ddoc.choices).toEqual(['design'])
    expect(props(ddoc)).toContain('replace')
    expect(ddoc.spec.description(config, ddoc)).toMatch(/consumes/)

    expect(tool('designer', 'hafiz_progress_append').choices).toEqual(['found', 'question'])
    // roles that log finished work mark plan steps with the same entry
    expect(props(tool('designer', 'hafiz_progress_append'))).not.toContain('step')
    const wp = tool('worker', 'hafiz_progress_append')
    expect(props(wp)).toContain('step')
    expect(wp.spec.description(config, wp)).toMatch(/also marks that plan step/)
    expect(tool('manager', 'hafiz_progress_append').choices).not.toContain('report')
    // the worker may not list the tree: id is required
    const wr = tool('worker', 'hafiz_block_read')
    expect(wr.spec.shape(config, wr).id?.safeParse(undefined).success).toBe(false)
    expect(wr.spec.description(config, wr)).not.toMatch(/the tree/)
  })

  it('keeps descriptions and schemas within the per-role budget', () => {
    const budget: Record<string, number> = {
      manager: 1000,
      designer: 1000,
      planner: 1000,
      worker: 500,
    }
    for (const [role, max] of Object.entries(budget)) {
      const total = toolsForRole(config, role, 'kilo').reduce(
        (n, t) => n + toolTokens(config, t, estimatorTokenizer),
        0,
      )
      expect(total, role).toBeLessThanOrEqual(max)
    }
  })
})
