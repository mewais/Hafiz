// The tool catalogue every gateway exposes: one tool per Core command/query, filtered by the
// role's allowlist. The MCP gateway and the Kilo plugin's native tools are both generated from
// it, so names, descriptions and argument schemas cannot drift. The descriptions are what agents
// read, so they carry the protocol hints.
import { z } from 'zod'
import type { Config } from '../config/schema.js'
import { isAllowed } from './authz.js'

export interface ToolSpec {
  /** Core command or query, e.g. `block.set_status`. */
  command: string
  /** `dispatch` goes through Core.dispatch; `query` has its own daemon method. */
  kind: 'dispatch' | 'query'
  /** Tool input that selects an allowlist qualifier (`doc.write:design`). */
  qualifier?: { param: string; values: readonly string[] }
  description(cfg: Config): string
  shape(cfg: Config, qualifiers: readonly string[]): z.ZodRawShape
  readOnly?: boolean
}

export const toolName = (command: string) => `hafiz_${command.replace(/\./g, '_')}`

const id = (what: string) => z.string().describe(what)
const expectedVersion = z
  .number()
  .int()
  .optional()
  .describe(
    'Version you read. If the object changed since, you get a conflict with the current value; re-read, merge, retry.',
  )
const sections = (hint: string) =>
  z
    .record(z.string(), z.unknown())
    .describe(
      `Object keyed by section name. ${hint} Formats: prose = string, list = string[], refs = [{label, ref}], steps = [{id, title, notes?}], interface = {provides?, consumes?, contracts?: [{name, type?, notes?}]}. Sections have token caps; an over-cap section is rejected with the remedy.`,
    )
const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]])

const DOC_TYPES = ['design', 'plan', 'digest'] as const
const PROGRESS_KINDS = ['done', 'blocked', 'found', 'changed', 'question', 'report'] as const
const STATUSES = ['planned', 'active', 'blocked', 'done', 'dropped'] as const

function qualified(allowed: readonly string[], all: readonly string[]) {
  const values = allowed.length ? allowed : all
  return enumOf(values)
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    command: 'context.for',
    kind: 'query',
    readOnly: true,
    description: () =>
      'Your structured project context: the block tree rendered for your role and focus, at the right level of detail per block, plus the always-shown standing decisions. Call at session start and whenever you are told the view changed. The trailing hash tells you if it differs from the last one you received.',
    shape: () => ({
      model: z
        .string()
        .optional()
        .describe('Model key for the window/budget table; omit normally.'),
      budget_tokens: z.number().int().positive().optional().describe('Override the view budget.'),
    }),
  },
  {
    command: 'context.explain',
    kind: 'query',
    readOnly: true,
    description: () =>
      'Explain why a block appears in your context at the zoom it does: which rule fired and which degrade steps applied. Use when a block you expect is missing or too terse.',
    shape: () => ({
      block: id('Block id.'),
      model: z.string().optional(),
      budget_tokens: z.number().int().positive().optional(),
    }),
  },
  {
    command: 'context.delta',
    kind: 'query',
    readOnly: true,
    description: () =>
      'Minor events (progress, steps, threads) on your focus and its dependencies since you last asked. Cheap way to catch up without re-reading the whole context.',
    shape: () => ({}),
  },
  {
    command: 'block.read',
    kind: 'query',
    readOnly: true,
    description: (cfg) =>
      `Read one block at a zoom level. Zooms, most to least detailed: ${Object.keys(cfg.zooms.zooms).join(', ')}. Default FULL. Prefer DESIGN or INTERFACE for blocks you only depend on.`,
    shape: () => ({
      id: id('Block id.'),
      zoom: z.string().optional().describe('Zoom name; default FULL.'),
    }),
  },
  {
    command: 'tree.list',
    kind: 'query',
    readOnly: true,
    description: () => 'The whole block tree: id, parent, title, kind, status, depth.',
    shape: () => ({}),
  },
  {
    command: 'session.status',
    kind: 'query',
    readOnly: true,
    description: () => 'Your session: role, focus, counters, view hash, pending notices.',
    shape: () => ({}),
  },
  {
    command: 'proposal.list',
    kind: 'query',
    readOnly: true,
    description: () =>
      'The review queue: pending proposals (done requests, auto-done reviews). Accepting performs the proposed command.',
    shape: () => ({
      status: z.enum(['pending', 'accepted', 'rejected']).optional().describe('Default: all.'),
    }),
  },
  {
    command: 'proposal.accept',
    kind: 'dispatch',
    description: () =>
      'Accept a pending proposal. For a worker done-request this marks the block done.',
    shape: () => ({ id: id('Proposal id from proposal_list.') }),
  },
  {
    command: 'proposal.reject',
    kind: 'dispatch',
    description: () => 'Reject a pending proposal; the block keeps its current status.',
    shape: () => ({ id: id('Proposal id from proposal_list.') }),
  },
  {
    command: 'block.create',
    kind: 'dispatch',
    description: (cfg) =>
      `Create a block under a parent. It starts as 'planned'. Kinds: ${Object.keys(cfg.kinds.kinds).join(', ')} (default ${cfg.kinds.default_kind}). A block is a unit of work or a component with its own design and plan; do not create one per task step (steps live in the plan).`,
    shape: (cfg) => ({
      parent: id('Parent block id.'),
      title: z.string().describe('Short title.'),
      kind: z
        .string()
        .optional()
        .describe(`One of: ${Object.keys(cfg.kinds.kinds).join(', ')}.`),
      order: z.number().int().optional().describe('Position among siblings; default last.'),
      design: sections('Optional initial design doc.').optional(),
      plan: sections('Optional initial plan doc (steps, acceptance).').optional(),
    }),
  },
  {
    command: 'block.update',
    kind: 'dispatch',
    description: () => 'Rename a block, change its kind or sibling order.',
    shape: () => ({
      id: id('Block id.'),
      title: z.string().optional(),
      kind: z.string().optional(),
      order: z.number().int().optional(),
      expected_version: expectedVersion,
    }),
  },
  {
    command: 'block.move',
    kind: 'dispatch',
    description: () => 'Re-parent a block (not under its own descendant).',
    shape: () => ({
      id: id('Block id.'),
      new_parent: id('New parent block id.'),
      expected_version: expectedVersion,
    }),
  },
  {
    command: 'block.set_status',
    kind: 'dispatch',
    qualifier: { param: 'status', values: STATUSES },
    description: () =>
      "Move a block along planned -> active -> done (or blocked/dropped; done -> active reopens). Guards: 'done' needs a fresh digest (pass `digest`), no open threads, and closed children; 'blocked' needs blocked_on; 'dropped' and reopening need a reason (recorded as a decision). If the result says confirmation is needed, ask the user, then call again with confirmed: true. Never set confirmed without the user's yes.",
    shape: (_cfg, q) => ({
      id: id('Block id.'),
      status: qualified(q, STATUSES),
      digest: sections(
        'Required when marking done unless a current digest exists: outcome, interface_delta, pointers.',
      ).optional(),
      reason: z.string().optional().describe('Why (required for dropped and reopen).'),
      blocked_on: z
        .object({
          kind: z.enum(['block', 'thread', 'user', 'external']),
          ref: z.string().optional(),
          note: z.string().optional(),
        })
        .optional()
        .describe("What the block waits on (required for 'blocked')."),
      confirmed: z
        .boolean()
        .optional()
        .describe('Set true only after the user confirmed marking done.'),
      expected_version: expectedVersion,
    }),
  },
  {
    command: 'block.request_done',
    kind: 'dispatch',
    description: () =>
      'Say your block is finished. A digest is REQUIRED: outcome (what now exists), interface_delta (what other blocks can rely on; "none" is allowed), pointers (files, commits, PRs). Open threads must be parked or resolved first. Depending on project policy the block becomes done at once or the request is queued for the manager. Call this instead of trying to set status yourself.',
    shape: () => ({
      id: id('Your block id.'),
      digest: sections('outcome, interface_delta, pointers are required; lessons optional.'),
    }),
  },
  {
    command: 'edge.add',
    kind: 'dispatch',
    description: () =>
      "Record that block `from` depends on block `to` (kind 'depends_on'). Dependencies pull the dependency's interface into the dependent's context.",
    shape: () => ({
      from: id('The dependent block.'),
      to: id('The block it depends on.'),
      kind: z.string().optional().describe("Default 'depends_on'."),
    }),
  },
  {
    command: 'edge.remove',
    kind: 'dispatch',
    description: () => 'Remove a dependency edge.',
    shape: () => ({
      from: id('Dependent block.'),
      to: id('Dependency block.'),
      kind: z.string().optional(),
    }),
  },
  {
    command: 'doc.write',
    kind: 'dispatch',
    qualifier: { param: 'type', values: DOC_TYPES },
    description: () =>
      'Replace a whole document (design, plan or digest) on a block. Sections not given are dropped; use doc_patch to change only some. Required sections must be present. Pass expected_version to avoid clobbering a concurrent edit.',
    shape: (_cfg, q) => ({
      block: id('Block id.'),
      type: qualified(q, DOC_TYPES),
      sections: sections('All sections of the document.'),
      expected_version: expectedVersion,
    }),
  },
  {
    command: 'doc.patch',
    kind: 'dispatch',
    qualifier: { param: 'type', values: DOC_TYPES },
    description: () =>
      'Replace only the named sections of a document; the others stay. Preferred for edits. Pass expected_version for design edits.',
    shape: (_cfg, q) => ({
      block: id('Block id.'),
      type: qualified(q, DOC_TYPES),
      sections: sections('Only the sections to replace.'),
      expected_version: expectedVersion,
    }),
  },
  {
    command: 'step.set',
    kind: 'dispatch',
    description: (cfg) =>
      `Mark a plan step ${cfg.logs.step.statuses.join(' / ')}. Step ids come from the block's plan. Cheap and append-only; do it as you go.`,
    shape: (cfg) => ({
      block: id('Block id.'),
      step_id: id('Step id from the plan.'),
      status: enumOf(cfg.logs.step.statuses),
    }),
  },
  {
    command: 'progress.append',
    kind: 'dispatch',
    qualifier: { param: 'kind', values: PROGRESS_KINDS },
    description: (cfg) =>
      `Append one entry to the block's progress log. ONE finding per entry, at most ~${cfg.logs.progress.cap} tokens; write several entries rather than one long one. Kinds: ${cfg.logs.progress.kinds.join(', ')}. Log what changed or what you learned, not what you are about to do.`,
    shape: (cfg, q) => ({
      block: id('Block id.'),
      kind: qualified(q, cfg.logs.progress.kinds),
      text: z.string().describe('One finding, one or two sentences.'),
      refs: z.array(z.string()).optional().describe('Files, commits, block ids.'),
    }),
  },
  {
    command: 'decision.record',
    kind: 'dispatch',
    description: () =>
      'Record a choice that was made, by the user or agreed in design, with its rationale. Not for findings, status or observations: use a research block or a progress entry (kind found). `standing` (never/always/prefer) makes it a standing instruction every agent sees; `supersedes` replaces an earlier decision.',
    shape: (cfg) => ({
      block: id('Block the decision belongs to (the root for project-wide rules).'),
      title: z.string(),
      decision: z.string(),
      rationale: z.string().optional(),
      standing: enumOf(cfg.logs.decision.standing).optional(),
      supersedes: z.string().optional().describe('Id of the decision this replaces.'),
    }),
  },
  {
    command: 'thread.open',
    kind: 'dispatch',
    description: () =>
      'Open a discussion thread on a block for an open question or a topic you want to come back to. Threads must be parked or resolved before the block can be done.',
    shape: () => ({
      block: id('Block id.'),
      title: z.string(),
      text: z.string().optional().describe('First entry.'),
    }),
  },
  {
    command: 'thread.park',
    kind: 'dispatch',
    description: (cfg) =>
      `Park an open thread to set it aside. A gist is REQUIRED (<= ~${cfg.logs.thread.gist_cap} tokens): what was discussed and where it stands, so someone can resume without the history. Only the title and gist stay in context.`,
    shape: () => ({
      id: id('Thread id.'),
      gist: z.string().describe('What was discussed and where it stands.'),
    }),
  },
  {
    command: 'thread.resume',
    kind: 'dispatch',
    description: () => 'Reopen a parked thread.',
    shape: () => ({ id: id('Thread id.') }),
  },
  {
    command: 'thread.resolve',
    kind: 'dispatch',
    description: () =>
      'Close a thread. Put the outcome in `outcome`; record durable choices with decision_record.',
    shape: () => ({ id: id('Thread id.'), outcome: z.string().optional() }),
  },
  {
    command: 'thread.append',
    kind: 'dispatch',
    description: (cfg) => `Add an entry to a thread (<= ~${cfg.logs.thread.entry_cap} tokens).`,
    shape: () => ({ id: id('Thread id.'), text: z.string() }),
  },
  {
    command: 'focus.set',
    kind: 'dispatch',
    description: () =>
      'Set which blocks your context centres on (replaces the computed focus until the session ends). The listed blocks get full detail; keep the list short.',
    shape: () => ({
      blocks: z.array(z.string()).describe('Block ids, most important first.'),
      order: z.array(z.string()).optional(),
    }),
  },
]

/** A tool the role can see, with the qualifiers it may use. */
export interface RoleTool {
  spec: ToolSpec
  qualifiers: string[]
}

export function toolsForRole(config: Config, role: string): RoleTool[] {
  const def = config.roles.roles[role]
  if (!def) throw new Error(`unknown role '${role}'`)
  const out: RoleTool[] = []
  for (const spec of TOOL_SPECS) {
    if (spec.qualifier) {
      const qualifiers = spec.qualifier.values.filter((q) => isAllowed(def.tools, spec.command, q))
      if (qualifiers.length) out.push({ spec, qualifiers })
    } else if (isAllowed(def.tools, spec.command)) out.push({ spec, qualifiers: [] })
  }
  return out
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
