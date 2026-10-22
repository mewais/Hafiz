// The agent tool catalogue: what agents see, generated per role from the allowlist. Each tool
// routes a call to one Core command or query (catalogue.ts); several commands share a tool where
// an agent thinks of them as one action (`hafiz_thread` → thread.open/append/park/…). The MCP
// gateway and the Kilo plugin's native tools are both built from it, so names, descriptions and
// schemas cannot drift. The descriptions are the one place a tool's mechanics are written down
// (preconditions, required arguments, what happens); the rules files say when to use them.
import { z } from 'zod'
import type { Config } from '../config/schema.js'
import { ValidationError } from '../domain/errors.js'
import { isAllowed } from './authz.js'

/** Hosts that list catalogue tools. Kilo injects the context, so it skips the context reads. */
export type ToolHost = 'kilo' | 'mcp'

/** May the role run this command (with this allowlist qualifier)? */
export type Can = (command: string, qualifier?: string) => boolean

/** One value of a tool's enum input and the grants (`command` or `command:qualifier`) behind it. */
export interface ToolOption {
  value: string
  grants: readonly string[]
}

/** A tool call resolved to one Core command or query, with tool-form (snake_case) args. */
export interface ToolRoute {
  command: string
  args: Record<string, unknown>
}

export interface ToolSpec {
  name: string
  /** Commands a call may route to. Without `choice`, a role sees the tool if it may run one. */
  commands: readonly string[]
  /** Hosts that list the tool; default: every host. */
  hosts?: readonly ToolHost[]
  /**
   * An enum input narrowed per role to the values it holds a grant for, the way `doc.write:design`
   * narrows `type`. A role sees the tool when at least one value is left.
   */
  choice?: { param: string; options(cfg: Config): readonly ToolOption[] }
  readOnly?: boolean
  description(cfg: Config, t: RoleTool): string
  shape(cfg: Config, t: RoleTool): z.ZodRawShape
  route(args: Record<string, unknown>, t: RoleTool): ToolRoute
}

/** A tool as one role (or, `shared`, every role a host registers it for) may use it. */
export interface RoleTool {
  spec: ToolSpec
  /** The `choice` values allowed; empty when the tool has no choice. */
  choices: string[]
  can: Can
  /** One definition serving several roles (Kilo's tools are global): describe every path. */
  shared?: boolean
}

const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]])
/** `{section: value}`; Core validates the sections against the kind's schema. */
const sectionsArg = () => z.looseObject({})
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)
const pick = (args: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]))
const option = (value: string, ...grants: string[]): ToolOption => ({ value, grants })
const sentences = (...xs: Array<string | false | undefined>) => xs.filter(Boolean).join(' ')

function need(args: Record<string, unknown>, keys: readonly string[], what: string): void {
  const missing = keys.filter((k) => args[k] === undefined || args[k] === '')
  if (missing.length) throw new ValidationError(`${what} needs ${missing.join(', ')}`, { missing })
}

const FORMATS: Record<string, string> = {
  prose: 'string',
  list: '[string]',
  refs: '[{label, ref}]',
  steps: '[{id, title, notes?}]',
  structured: '{provides, consumes, contracts} of [{name, type?, notes?}]',
}

/**
 * The sections a document type takes, grouped by format, from the configured schemas (every
 * kind): `steps: [{id, title, notes?}]; acceptance, risks: [string]`. With `caps: 'all'`, first
 * the sections per kind (kinds sharing a schema together) with their token caps, `*` = required:
 * `component, feature: purpose* 150, scope* 200 | …`; `caps: 'required'` lists only the required
 * sections and caps, without the value shapes.
 */
export function sectionsHint(
  config: Config,
  types: readonly string[],
  opts: { caps?: 'all' | 'required' } = {},
): string {
  const byFormat = new Map<string, Set<string>>()
  for (const s of Object.values(config.schemas))
    if (types.includes(s.type))
      for (const sec of s.sections) {
        const names = byFormat.get(sec.format) ?? new Set<string>()
        names.add(sec.name)
        byFormat.set(sec.format, names)
      }
  const formats = Object.keys(FORMATS)
    .filter((f) => byFormat.has(f))
    .map((f) => `${[...(byFormat.get(f) ?? [])].join(', ')}: ${FORMATS[f]}`)
    .join('; ')
  if (!opts.caps) return formats
  const required = opts.caps === 'required'
  const per = types.map((t) => [t, capsHint(config, t, required)] as const)
  const caps = per.length === 1 ? per[0]?.[1] : per.map(([t, h]) => `${t} [${h}]`).join('; ')
  return required
    ? `required sections (cap in tokens): ${caps}`
    : `Sections (* required, cap in tokens): ${caps}. Values: ${formats}`
}

/** `kind, kind: name* cap, … | kind: …` for one doc type; one schema for all kinds drops the kinds. */
function capsHint(config: Config, type: string, requiredOnly: boolean): string {
  const kindsBySchema = new Map<string, string[]>()
  for (const [kind, k] of Object.entries(config.kinds.kinds)) {
    const name = k.schemas[type]
    if (name && config.schemas[name])
      kindsBySchema.set(name, [...(kindsBySchema.get(name) ?? []), kind])
  }
  return [...kindsBySchema]
    .map(([name, kinds]) => {
      const secs = (config.schemas[name]?.sections ?? [])
        .filter((x) => !requiredOnly || x.required)
        .map((x) => `${x.name}${x.required && !requiredOnly ? '*' : ''} ${x.cap}`)
        .join(', ')
      return kindsBySchema.size > 1 ? `${kinds.join(', ')}: ${secs}` : secs
    })
    .join(' | ')
}

/** Zooms that render something (not `NONE`). */
const readableZooms = (cfg: Config) =>
  Object.entries(cfg.zooms.zooms)
    .filter(([, parts]) => parts.length)
    .map(([z]) => z)

const STATUSES = ['planned', 'active', 'blocked', 'done', 'dropped'] as const
const BLOCKED_ON = ['block', 'thread', 'user', 'external'] as const
const DOC_TYPES = ['design', 'plan', 'digest'] as const
const THREAD_ACTIONS = ['open', 'append', 'park', 'resume', 'resolve'] as const
const REVIEW_ACTIONS = {
  list: 'proposal.list',
  accept: 'proposal.accept',
  reject: 'proposal.reject',
}

/** Arguments each thread action takes (`id` is the thread id; `block` only for open). */
const THREAD_ARGS: Record<string, { need: string[]; keep: string[] }> = {
  open: { need: ['block', 'title'], keep: ['block', 'title', 'text'] },
  append: { need: ['id', 'text'], keep: ['id', 'text'] },
  park: { need: ['id'], keep: ['id', 'gist'] }, // a missing gist is Core's to refuse (or draft)
  resume: { need: ['id'], keep: ['id'] },
  resolve: { need: ['id'], keep: ['id', 'outcome'] },
}

/** Whether `done` closes the block (set_status) or asks for it (request_done). */
const closesBlocks = (t: RoleTool) => t.can('block.set_status', 'done')

/** `block:<id>`, `thread:<id>`, `user`, `external:<note>` → Core's BlockedOn. */
function blockedOn(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'string') return undefined
  const [kind = '', ...rest] = v.split(':')
  const ref = rest.join(':').trim()
  if (!(BLOCKED_ON as readonly string[]).includes(kind))
    throw new ValidationError(
      `blocked_on must be one of ${BLOCKED_ON.map((k) => `${k}:…`).join(', ')}`,
    )
  if (!ref) return { kind }
  return kind === 'block' || kind === 'thread' ? { kind, ref } : { kind, note: ref }
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'hafiz_context_for',
    commands: ['context.for'],
    hosts: ['mcp'],
    readOnly: true,
    description: () =>
      'Your project context: the block tree rendered for your role and focus, plus the standing decisions. Call at session start and when told the view changed; the trailing hash shows whether it did.',
    shape: () => ({
      model: z.string().optional().describe('Model key for the budget table; omit normally.'),
      budget_tokens: z.number().optional(),
    }),
    route: (a) => ({ command: 'context.for', args: pick(a, ['model', 'budget_tokens']) }),
  },
  {
    name: 'hafiz_context_delta',
    commands: ['context.delta'],
    hosts: ['mcp'],
    readOnly: true,
    description: () =>
      'Minor events (progress, steps, threads) on your focus and its dependencies since you last asked: a cheap catch-up.',
    shape: () => ({}),
    route: () => ({ command: 'context.delta', args: {} }),
  },
  {
    name: 'hafiz_session_status',
    commands: ['session.status'],
    hosts: ['mcp'],
    readOnly: true,
    description: () => 'Your session: role, focus, counters, view hash, pending notices.',
    shape: () => ({}),
    route: () => ({ command: 'session.status', args: {} }),
  },
  {
    name: 'hafiz_block_read',
    commands: ['block.read', 'tree.list', 'context.explain'],
    readOnly: true,
    description: (cfg, t) =>
      sentences(
        `Read a block (zoom: ${readableZooms(cfg).join(', ')}; default FULL).`,
        t.can('tree.list') && 'No id: the tree.',
        t.can('context.explain') && 'explain: why your context shows it as it does.',
      ),
    shape: (_cfg, t) => ({
      id: t.can('tree.list') ? z.string().optional() : z.string(),
      zoom: z.string().optional(),
      ...(t.can('context.explain') ? { explain: z.boolean().optional() } : {}),
    }),
    route: (a) => {
      const block = str(a.id)
      if (!block) return { command: 'tree.list', args: {} }
      if (a.explain === true) return { command: 'context.explain', args: { block } }
      return { command: 'block.read', args: { id: block, ...pick(a, ['zoom']) } }
    },
  },
  {
    name: 'hafiz_block_create',
    commands: ['block.create'],
    description: (cfg) =>
      `New planned block under parent; kind (default ${cfg.kinds.default_kind}) picks its doc sections. design, plan: {section: value} as in hafiz_doc; ${sectionsHint(cfg, ['design', 'plan'], { caps: 'required' })}.`,
    shape: () => ({
      parent: z.string(),
      title: z.string(),
      kind: z.string().optional(),
      design: sectionsArg().optional(),
      plan: sectionsArg().optional(),
    }),
    route: (a) => ({
      command: 'block.create',
      args: pick(a, ['parent', 'title', 'kind', 'design', 'plan']),
    }),
  },
  {
    name: 'hafiz_block_edit',
    commands: ['block.update', 'block.move'],
    description: () => 'Change title, kind or sibling order, or (alone) move under a new parent.',
    shape: () => ({
      id: z.string(),
      title: z.string().optional(),
      kind: z.string().optional(),
      order: z.number().optional(),
      parent: z.string().optional(),
    }),
    route: (a) => {
      const edits = pick(a, ['title', 'kind', 'order'])
      if (a.parent !== undefined) {
        if (Object.keys(edits).length)
          throw new ValidationError('move a block in a call of its own, without title/kind/order')
        return { command: 'block.move', args: { id: a.id, new_parent: a.parent } }
      }
      if (!Object.keys(edits).length)
        throw new ValidationError('nothing to change: pass title, kind, order or parent')
      return { command: 'block.update', args: { id: a.id, ...edits } }
    },
  },
  {
    name: 'hafiz_block_set_status',
    commands: ['block.set_status', 'block.request_done'],
    choice: {
      param: 'status',
      options: () =>
        STATUSES.map((s) =>
          s === 'done'
            ? option(s, 'block.set_status:done', 'block.request_done')
            : option(s, `block.set_status:${s}`),
        ),
    },
    description: (cfg, t) => {
      const done = t.choices.includes('done')
      return sentences(
        t.choices.some((s) => s !== 'done') &&
          'planned → active → done (→ active reopens). blocked needs blocked_on: block:<id>, thread:<id>, user or external:<note>; dropped and reopening a reason.',
        done &&
          `done needs digest {${sectionsHint(cfg, ['digest'])}}, no open threads, closed children.`,
        done &&
          (t.shared || !closesBlocks(t)) &&
          `${t.shared ? 'If your role cannot close blocks, done' : 'done'} is a request: policy closes it or queues it for review.`,
        done &&
          closesBlocks(t) &&
          'If asked to confirm, ask the user; on yes repeat with confirmed: true.',
      )
    },
    shape: (_cfg, t) => {
      const has = (s: string) => t.choices.includes(s)
      return {
        id: z.string(),
        status: enumOf(t.choices),
        ...(has('done') ? { digest: sectionsArg().optional() } : {}),
        ...(has('dropped') || has('active') ? { reason: z.string().optional() } : {}),
        ...(has('blocked') ? { blocked_on: z.string().optional() } : {}),
        ...(has('done') && closesBlocks(t) ? { confirmed: z.boolean().optional() } : {}),
      }
    },
    route: (a, t) => {
      if (a.status === 'done' && !closesBlocks(t)) {
        need(a, ['digest'], 'done')
        return { command: 'block.request_done', args: pick(a, ['id', 'digest']) }
      }
      const on = blockedOn(a.blocked_on)
      return {
        command: 'block.set_status',
        args: {
          ...pick(a, ['id', 'status', 'digest', 'reason', 'confirmed']),
          ...(on ? { blocked_on: on } : {}),
        },
      }
    },
  },
  {
    name: 'hafiz_doc',
    commands: ['doc.patch', 'doc.write'],
    choice: {
      param: 'type',
      options: () => DOC_TYPES.map((d) => option(d, `doc.patch:${d}`, `doc.write:${d}`)),
    },
    description: (cfg, t) =>
      sentences(
        `Patch a block's ${t.choices.join(' or ')}: only the sections given change.`,
        t.choices.some((d) => t.can('doc.write', d)) && 'replace: true rewrites it whole.',
        `${sectionsHint(cfg, t.choices, { caps: 'all' })}.`,
        t.choices.includes('design') &&
          'Each consumes entry names its provider id in block; dependencies follow.',
        'Once it exists, pass expected_version (from your last write or the rejection); on conflict re-read, merge, retry.',
      ),
    shape: (_cfg, t) => ({
      block: z.string(),
      type: enumOf(t.choices),
      sections: sectionsArg(),
      expected_version: z.number().optional(),
      ...(t.choices.some((d) => t.can('doc.write', d)) ? { replace: z.boolean().optional() } : {}),
    }),
    route: (a) => ({
      command: a.replace === true ? 'doc.write' : 'doc.patch',
      args: {
        ...pick(a, ['block', 'type', 'sections', 'expected_version']),
        require_version: true,
      },
    }),
  },
  {
    name: 'hafiz_step_set',
    commands: ['step.set'],
    description: () => "Set a step's status as you go (ids from the block's plan).",
    shape: (cfg) => ({
      block: z.string(),
      step_id: z.string(),
      status: enumOf(cfg.logs.step.statuses),
    }),
    route: (a) => ({ command: 'step.set', args: pick(a, ['block', 'step_id', 'status']) }),
  },
  {
    name: 'hafiz_progress_append',
    commands: ['progress.append'],
    choice: {
      param: 'kind',
      // `report` entries are Hafiz's own capture of a subagent's final message.
      options: (cfg) =>
        cfg.logs.progress.kinds
          .filter((k) => k !== 'report')
          .map((k) => option(k, `progress.append:${k}`)),
    },
    description: (cfg) =>
      `One finding for a block's progress log: one or two sentences, <= ~${cfg.logs.progress.cap} tokens; write several rather than one long one.`,
    shape: (_cfg, t) => ({
      block: z.string(),
      kind: enumOf(t.choices),
      text: z.string(),
      refs: z.array(z.string()).optional(),
    }),
    route: (a) => ({
      command: 'progress.append',
      args: pick(a, ['block', 'kind', 'text', 'refs']),
    }),
  },
  {
    name: 'hafiz_decision_record',
    commands: ['decision.record'],
    description: () =>
      'A choice made and why; never a finding or status. block: root for project-wide rules. standing: binds every agent. supersedes: id of the decision it replaces.',
    shape: (cfg) => ({
      block: z.string(),
      title: z.string(),
      decision: z.string(),
      rationale: z.string().optional(),
      standing: enumOf(cfg.logs.decision.standing).optional(),
      supersedes: z.string().optional(),
    }),
    route: (a) => ({
      command: 'decision.record',
      args: pick(a, ['block', 'title', 'decision', 'rationale', 'standing', 'supersedes']),
    }),
  },
  {
    name: 'hafiz_thread',
    commands: THREAD_ACTIONS.map((x) => `thread.${x}`),
    choice: {
      param: 'action',
      options: () => THREAD_ACTIONS.map((x) => option(x, `thread.${x}`)),
    },
    description: (cfg, t) => {
      const has = (x: string) => t.choices.includes(x)
      const actions = [
        has('open') && 'open: block, title, text?',
        has('append') && 'append: id, text',
        has('park') &&
          `park: id, gist (required, <= ~${cfg.logs.thread.gist_cap} tokens: what was said, where it stands)`,
        has('resume') && 'resume: id',
        has('resolve') && 'resolve: id, outcome?',
      ].filter(Boolean)
      return `Discussion on a block; it cannot be done while one is open. ${actions.join('. ')}.`
    },
    shape: (_cfg, t) => {
      const has = (x: string) => t.choices.includes(x)
      return {
        action: enumOf(t.choices),
        ...(has('open') ? { block: z.string().optional(), title: z.string().optional() } : {}),
        ...(t.choices.some((x) => x !== 'open') ? { id: z.string().optional() } : {}),
        ...(has('open') || has('append') ? { text: z.string().optional() } : {}),
        ...(has('park') ? { gist: z.string().optional() } : {}),
        ...(has('resolve') ? { outcome: z.string().optional() } : {}),
      }
    },
    route: (a) => {
      const action = String(a.action)
      const spec = THREAD_ARGS[action]
      if (!spec) throw new ValidationError(`unknown thread action '${action}'`)
      need(a, spec.need, `thread ${action}`)
      return { command: `thread.${action}`, args: pick(a, spec.keep) }
    },
  },
  {
    name: 'hafiz_review',
    commands: Object.values(REVIEW_ACTIONS),
    choice: {
      param: 'action',
      options: () => Object.entries(REVIEW_ACTIONS).map(([x, c]) => option(x, c)),
    },
    description: (cfg, t) =>
      sentences(
        'Review queue. list: pending proposals and what accepting runs. accept: id, runs it. reject: id, note (why).',
        t.choices.includes('accept') &&
          `Design and plan reviews: ${cfg.policies.review.approver === 'user' ? 'the user only' : 'you or the user'}.`,
      ),
    shape: (_cfg, t) => ({
      action: enumOf(t.choices),
      ...(t.choices.some((x) => x !== 'list') ? { id: z.string().optional() } : {}),
      ...(t.choices.includes('reject') ? { note: z.string().optional() } : {}),
    }),
    route: (a) => {
      const action = String(a.action) as keyof typeof REVIEW_ACTIONS
      const command = REVIEW_ACTIONS[action]
      if (!command) throw new ValidationError(`unknown review action '${String(a.action)}'`)
      if (action === 'list') return { command, args: { status: 'pending' } }
      need(a, ['id'], `review ${action}`)
      return { command, args: pick(a, action === 'reject' ? ['id', 'note'] : ['id']) }
    },
  },
  {
    name: 'hafiz_focus_set',
    commands: ['focus.set'],
    description: () => 'Centre your context on these blocks (most important first) this session.',
    shape: () => ({ blocks: z.array(z.string()) }),
    route: (a) => ({ command: 'focus.set', args: pick(a, ['blocks']) }),
  },
]

const grantHeld = (can: Can, grant: string) => {
  const [command, qualifier] = grant.split(':') as [string, string | undefined]
  return can(command, qualifier)
}

/** The tool as `can` allows it, or undefined when it allows none of it. */
export function roleTool(
  config: Config,
  spec: ToolSpec,
  can: Can,
  shared?: boolean,
): RoleTool | undefined {
  const t = (choices: string[]): RoleTool => ({ spec, choices, can, ...(shared ? { shared } : {}) })
  if (!spec.choice) return spec.commands.some((c) => can(c)) ? t([]) : undefined
  const choices = spec.choice
    .options(config)
    .filter((o) => o.grants.some((g) => grantHeld(can, g)))
    .map((o) => o.value)
  return choices.length ? t(choices) : undefined
}

/** The tools a role sees, in catalogue order; `host` drops the tools that host does not list. */
export function toolsForRole(config: Config, role: string, host?: ToolHost): RoleTool[] {
  const def = config.roles.roles[role]
  if (!def) throw new Error(`unknown role '${role}'`)
  const can: Can = (command, qualifier) => isAllowed(def.tools, command, qualifier)
  return TOOL_SPECS.filter((s) => !host || !s.hosts || s.hosts.includes(host)).flatMap((s) => {
    const t = roleTool(config, s, can)
    return t ? [t] : []
  })
}

/** Resolve one call: which command runs, with Core's (camelCase) args. Throws ValidationError. */
export function routeTool(t: RoleTool, args: Record<string, unknown>): ToolRoute {
  const r = t.spec.route(args, t)
  return { command: r.command, args: toCoreArgs(r.args) }
}

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Tool args are snake_case; Core's are camelCase. Top-level keys only. */
export function toCoreArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [camel(k), v]),
  )
}

/**
 * What a tool costs in every request, by `tok`: its description plus its parameters' JSON Schema
 * (the per-tool object wrapper every host adds is left out).
 */
export function toolTokens(
  config: Config,
  t: RoleTool,
  tok: { count(text: string): number },
): number {
  const schema = z.toJSONSchema(z.object(t.spec.shape(config, t))) as { properties?: unknown }
  return tok.count(t.spec.description(config, t)) + tok.count(JSON.stringify(schema.properties))
}
