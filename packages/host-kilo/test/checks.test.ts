// The mechanical checks on Kilo's own tools (checks.ts), against a fake session registry.
import { type Config, loadConfig, type TreeSummaryNode } from '@hafiz/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  BLOCK_ARG_DESCRIPTION,
  type CheckSessions,
  createChecks,
  HafizToolError,
  UNFINISHED,
} from '../src/index.js'

const ROLES = new Set(['manager', 'designer', 'planner', 'worker'])
const STORE = '/home/u/.local/share/hafiz/stores/prj_1'

const node = (
  id: string,
  title: string,
  status: TreeSummaryNode['status'],
  docs: Partial<TreeSummaryNode['docs']> = {},
): TreeSummaryNode => ({
  id,
  parentId: null,
  title,
  kind: 'component',
  status,
  order: 0,
  depth: 0,
  docs: { design: 0, plan: 0, digest: 0, ...docs },
  threads: [],
  decisions: 0,
  recentDecisions: [],
})

const NODES = [
  node('blk_root', 'Shop', 'active', { design: 1 }),
  node('blk_new', 'Search', 'planned'),
  node('blk_des', 'Payments', 'active', { design: 2 }),
  node('blk_pln', 'Refunds', 'active', { design: 1, plan: 1 }),
  node('blk_fin', 'Login', 'done', { design: 1, plan: 1, digest: 1 }),
  node('blk_drp', 'Legacy', 'dropped'),
]

/** `ses_m` is a managed manager; children are known by id with their role. */
function fakeSessions(
  o: { commands?: string[]; children?: Record<string, string>; nodes?: TreeSummaryNode[] } = {},
) {
  const calls: Array<{ id: string; method: string }> = []
  const children = o.children ?? {}
  const s: CheckSessions & { calls: typeof calls } = {
    calls,
    isManaged: (id) => id === 'ses_m' || id in children,
    get: (id) =>
      id === 'ses_m'
        ? { role: 'manager' }
        : children[id]
          ? { role: children[id], block: 'blk_pln' }
          : undefined,
    isRoleAgent: (a) => !!a && ROLES.has(a),
    roleFor: (a, w) => (a && ROLES.has(a) ? a : w.subagent && w.block ? 'worker' : undefined),
    call: async <T>(id: string, method: string) => {
      calls.push({ id, method })
      if (method === 'tree.summary')
        return { project: null, nodes: o.nodes ?? NODES, standing: [] } as T
      if (method === 'session.activity') return { commands: o.commands ?? [] } as T
      throw new Error(`unexpected ${method}`)
    },
  }
  return s
}

function setup(o: Parameters<typeof fakeSessions>[0] = {}, config: Config = loadConfig()) {
  const sessions = fakeSessions(o)
  return { sessions, checks: createChecks({ config, storeDir: STORE, sessions }) }
}

/** Run `task` through the before-hook as session `sid`; resolves to the (amended) args. */
async function task(
  checks: ReturnType<typeof createChecks>,
  args: Record<string, unknown>,
  sid = 'ses_m',
) {
  const out = { args: { description: 'd', prompt: 'Fix rounding.', ...args } }
  await checks.before({ tool: 'task', sessionID: sid }, out)
  return out.args
}

const refused = async (p: Promise<unknown>, pattern: RegExp) => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(HafizToolError)
  expect(String((e as Error).message)).toMatch(pattern)
}

describe('task: a required block argument', () => {
  it('adds `block` to the task schema: Effect Struct, zod object or JSON Schema', () => {
    const { checks } = setup()
    // Kilo's built-in tools carry an Effect Schema Struct; we touch only fields/mapFields/annotate
    const prompt = { annotate: (a: Record<string, unknown>) => ({ kind: 'string', ...a }) }
    const effect = {
      fields: { prompt },
      mapFields(f: (x: Record<string, unknown>) => Record<string, unknown>) {
        return { fields: f(this.fields) }
      },
    }
    const out: { parameters: unknown; jsonSchema?: unknown } = { parameters: effect }
    checks.definition('task', out)
    const fields = (out.parameters as { fields: Record<string, unknown> }).fields
    expect(fields.block).toEqual({ kind: 'string', description: BLOCK_ARG_DESCRIPTION })
    expect(fields.prompt).toBe(prompt)
    // cached: the same schema object every request, so Kilo's own cache keeps working
    const again: { parameters: unknown } = { parameters: effect }
    checks.definition('task', again)
    expect(again.parameters).toBe(out.parameters)

    const zod: { parameters: unknown } = { parameters: z.object({ prompt: z.string() }) }
    checks.definition('task', zod)
    const json = z.toJSONSchema(zod.parameters as z.ZodType) as { required: string[] }
    expect(json.required).toEqual(['prompt', 'block'])

    const withJson = {
      parameters: {},
      jsonSchema: { type: 'object', properties: { prompt: {} }, required: ['prompt'] },
    }
    checks.definition('task', withJson)
    expect(withJson.jsonSchema).toMatchObject({
      required: ['prompt', 'block'],
      properties: { block: { type: 'string' } },
    })

    // other tools are left alone
    const read = { parameters: effect }
    checks.definition('read', read)
    expect(read.parameters).toBe(effect)
  })

  it('resolves the block (id, prefix, title) and carries it as the marker', async () => {
    const { checks } = setup()
    expect((await task(checks, { subagent_type: 'worker', block: 'blk_pln' })).prompt).toBe(
      'hafiz:block=blk_pln\nFix rounding.',
    )
    expect((await task(checks, { subagent_type: 'worker', block: 'blk_pl' })).prompt).toMatch(
      /^hafiz:block=blk_pln\n/,
    )
    expect((await task(checks, { subagent_type: 'worker', block: 'refunds' })).prompt).toMatch(
      /^hafiz:block=blk_pln\n/,
    )
    // a marker the model wrote itself is replaced by the checked one
    const a = await task(checks, {
      subagent_type: 'worker',
      block: 'blk_pln',
      prompt: 'hafiz:block=blk_x go',
    })
    expect(a.prompt).toBe('hafiz:block=blk_pln\ngo')
  })

  it('refuses a missing or unknown block, listing the valid ids', async () => {
    const { checks } = setup()
    await refused(task(checks, { subagent_type: 'worker' }), /task needs block/)
    await refused(
      task(checks, { subagent_type: 'worker', block: 'nope' }),
      /no block 'nope'[\s\S]*blk_pln — Refunds/,
    )
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_' }),
      /ambiguous \(id prefix\)/,
    )
  })

  it('none: helpers only, never a Hafiz role agent', async () => {
    const { checks, sessions } = setup()
    const a = await task(checks, { subagent_type: 'explore', block: 'none' })
    expect(a.prompt).toBe('Fix rounding.')
    for (const role of ['designer', 'planner', 'worker'])
      await refused(task(checks, { subagent_type: role, block: 'none' }), /Hafiz role agent/)
    expect(sessions.calls).toEqual([])
  })

  it('leaves a command subtask (started by Kilo, no block) alone', async () => {
    const { checks } = setup()
    const a = await task(checks, { subagent_type: 'worker', command: 'review' })
    expect(a.prompt).toBe('Fix rounding.')
  })
})

describe('task: the spawn fits the block', () => {
  it('a worker on a parent without a plan is pointed at its open children', async () => {
    const kid = (id: string, title: string, status: TreeSummaryNode['status']) => ({
      ...node(id, title, status, { design: 1, plan: 1 }),
      parentId: 'blk_des',
    })
    const nodes = [
      ...NODES,
      kid('blk_k1', 'Coupons', 'planned'),
      kid('blk_k2', 'Apply', 'active'),
      kid('blk_k3', 'Old', 'done'),
    ]
    const { checks } = setup({ nodes })
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_des' }),
      /its work is in its children \(Coupons \[blk_k1\], Apply \[blk_k2\]\): spawn on those/,
    )
  })

  it('no design → designer; no plan → designer or planner; planned → anyone', async () => {
    const { checks } = setup()
    await task(checks, { subagent_type: 'designer', block: 'blk_new' })
    await refused(
      task(checks, { subagent_type: 'planner', block: 'blk_new' }),
      /no planner on Search \[blk_new\]: it has no design yet, so the designer goes first\. Can be spawned on it now: designer\./,
    )
    await refused(task(checks, { subagent_type: 'worker', block: 'blk_new' }), /no design yet/)
    await task(checks, { subagent_type: 'planner', block: 'blk_des' })
    await task(checks, { subagent_type: 'designer', block: 'blk_des' })
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_des' }),
      /no plan yet, so the planner goes next/,
    )
    // a plain subagent on a block is managed as the default subagent role (worker)
    await refused(
      task(checks, { subagent_type: 'general', block: 'blk_des' }),
      /no worker on Payments/,
    )
    for (const r of ['designer', 'planner', 'worker'])
      await task(checks, { subagent_type: r, block: 'blk_pln' })
  })

  it('done or dropped → nobody', async () => {
    const { checks } = setup()
    await refused(
      task(checks, { subagent_type: 'designer', block: 'blk_fin' }),
      /it is done; reopen it first.*Nobody can be spawned/,
    )
    await refused(task(checks, { subagent_type: 'worker', block: 'blk_drp' }), /it is dropped/)
  })

  it('reads the table from policies.yaml', async () => {
    const config = loadConfig()
    config.policies.spawn.roles_by_state.no_design = ['designer', 'worker']
    const { checks } = setup({}, config)
    await task(checks, { subagent_type: 'worker', block: 'blk_new' })
  })
})

describe('task: a gated review holds the next stage on its block', () => {
  const review = (
    status: 'pending' | 'rejected',
    version: number,
    extra: { resolutionNote?: string } = {},
  ) => ({ proposal: `prop_${status}`, version, status, mode: 'gate' as const, ...extra })
  const NODES_REVIEW = [
    {
      ...node('blk_d', 'Payments', 'active', { design: 3, plan: 1 }),
      review: { design: review('pending', 3) },
    },
    {
      ...node('blk_p', 'Refunds', 'active', { design: 1, plan: 2 }),
      review: { plan: review('pending', 2) },
    },
    {
      ...node('blk_x', 'Search', 'active', { design: 2, plan: 1 }),
      review: { design: review('rejected', 2, { resolutionNote: 'split the index' }) },
    },
    node('blk_s', 'Shipping', 'active', { design: 1, plan: 1 }),
  ]
  const gated = (row: 'gate' | 'queue' = 'gate') => {
    const config = loadConfig()
    config.policies.review.design = row
    config.policies.review.plan = row
    return setup({ nodes: NODES_REVIEW }, config)
  }

  it('design under review: no planner or worker until accepted; the designer may revise', async () => {
    const { checks } = gated()
    await refused(
      task(checks, { subagent_type: 'planner', block: 'blk_d' }),
      /no planner on Payments \[blk_d\]: design of Payments \(v3\) awaits review: hafiz review --accept prop_pending/,
    )
    await refused(task(checks, { subagent_type: 'worker', block: 'blk_d' }), /awaits review/)
    await task(checks, { subagent_type: 'designer', block: 'blk_d' })
  })

  it('plan under review: no worker; designer and planner may go on', async () => {
    const { checks } = gated()
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_p' }),
      /plan of Refunds \(v2\) awaits review: hafiz review --accept prop_pending/,
    )
    for (const r of ['designer', 'planner'])
      await task(checks, { subagent_type: r, block: 'blk_p' })
  })

  it('a rejected design holds until revised, and says why', async () => {
    const { checks } = gated()
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_x' }),
      /design of Search \(v2\) was rejected: split the index; revise it/,
    )
  })

  it('holds one block only, and nothing under queue', async () => {
    await task(gated().checks, { subagent_type: 'worker', block: 'blk_s' })
    const { checks } = gated('queue')
    for (const b of ['blk_d', 'blk_p', 'blk_x'])
      await task(checks, { subagent_type: 'worker', block: b })
  })
})

describe('task: pass the block, not its contents', () => {
  it('refuses a prompt quoting Hafiz context', async () => {
    const { checks } = setup()
    const prompt = '<hafiz hash="abc" role="manager">\n# Shop\n</hafiz>\nDo it.'
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_pln', prompt }),
      /already sees its block/,
    )
    await refused(
      task(checks, { subagent_type: 'explore', block: 'none', prompt }),
      /outside Hafiz gets the task only/,
    )
  })

  it('refuses a prompt over host.kilo.delegation_prompt_cap tokens', async () => {
    const config = loadConfig()
    expect(config.hafiz.host.kilo.delegation_prompt_cap).toBe(600)
    config.hafiz.host.kilo.delegation_prompt_cap = 20
    const { checks } = setup({}, config)
    const prompt = 'Implement the refund flow exactly as the design says. '.repeat(5)
    await refused(
      task(checks, { subagent_type: 'worker', block: 'blk_pln', prompt }),
      /tokens \(cap 20\)\. The subagent already sees its block/,
    )
    await task(checks, {
      subagent_type: 'worker',
      block: 'blk_pln',
      prompt: 'Refunds, as discussed.',
    })
  })
})

describe('task: only the hafiz-report reaches the parent', () => {
  const result = (text: string) =>
    `<task id="ses_w" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`
  const report = '```hafiz-report\noutcome: done — refunds work\n```'

  it('replaces the output with the report block once the text is stored', async () => {
    const { checks } = setup({ children: { ses_w: 'worker' }, commands: ['block.request_done'] })
    const out = await checks.handback('ses_w', result(`Long story…\n\n${report}`), 'blk_pln')
    expect(out).toBe(result(report))
    // not stored (capture off): nothing is dropped
    const kept = await checks.handback('ses_w', result(`Long story…\n\n${report}`), undefined)
    expect(kept).toBe(result(`Long story…\n\n${report}`))
  })

  it('says when there is no report, and where the text is', async () => {
    const { checks } = setup({
      children: { ses_w: 'worker' },
      commands: ['progress.append:blocked'],
    })
    const out = await checks.handback('ses_w', result('I did things.'), 'blk_pln')
    expect(out).toBe(
      result('I did things.\nno hafiz-report in this result; full text stored on block blk_pln'),
    )
  })

  it('notes a worker that ended without a done request or a blocked entry', async () => {
    const { checks, sessions } = setup({
      children: { ses_w: 'worker' },
      commands: ['progress.append:found'],
    })
    const out = await checks.handback('ses_w', result(report), 'blk_pln')
    expect(out).toBe(result(`${report}\n${UNFINISHED}`))
    expect(sessions.calls).toEqual([{ id: 'ses_w', method: 'session.activity' }])
    // a designer does not finish blocks: no such line, no query
    const d = setup({ children: { ses_d: 'designer' } })
    expect(await d.checks.handback('ses_d', result(report), 'blk_pln')).toBe(result(report))
    expect(d.sessions.calls).toEqual([])
  })
})

describe('bash: the store is Hafiz’s', () => {
  it('refuses commands naming the store directory, for managed sessions only', async () => {
    const { checks } = setup()
    const bash = (command: string, sid = 'ses_m') =>
      checks.before({ tool: 'bash', sessionID: sid }, { args: { command } })
    await refused(bash(`cat ${STORE}/blocks/blk_1.yaml`), /touches the Hafiz store.*hafiz_\* tools/)
    await bash('git status')
    await bash(`cat ${STORE}/x`, 'ses_other')
  })
})

describe('unmanaged sessions', () => {
  it('pass through every check untouched', async () => {
    const { checks, sessions } = setup()
    const args = { subagent_type: 'worker', prompt: '<hafiz>', description: 'd' }
    await checks.before({ tool: 'task', sessionID: 'ses_plain' }, { args })
    expect(args.prompt).toBe('<hafiz>')
    expect(sessions.calls).toEqual([])
  })
})
