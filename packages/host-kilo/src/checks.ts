// Mechanical checks around Kilo's own tools, for managed sessions only (ARCHITECTURE §12.1).
// Hafiz shapes the tools agents see (`tool.definition`) and vetoes calls before they run
// (`tool.execute.before`), so a rule that can be checked is a check, not a sentence in a prompt:
// - `task` takes a required `block` (a block id, or `none` for a helper outside Hafiz); the id is
//   resolved and carried to the child as the `hafiz:block=<id>` marker (sessions.ts);
// - the spawned role must fit the block's state (`policies.yaml spawn.roles_by_state`), where a
//   design or plan held by a `gate` review (`policies.yaml review`) counts as not there yet;
// - the prompt passes the block, not its contents (no `<hafiz…>`, at most
//   `host.kilo.delegation_prompt_cap` tokens);
// - only the child's `hafiz-report` reaches the parent (its full text is in the store), plus a
//   line when a worker ended without asking for done or recording what blocks it;
// - `bash` never touches the store directory.
// A thrown HafizToolError becomes the tool error the model reads. Unmanaged sessions (and the
// condenser's helper sessions, which are never managed) pass through untouched.
import {
  blockList,
  type Config,
  estimatorTokenizer,
  gatingReview,
  isAllowed,
  matchBlock,
  type ReviewType,
  type SpawnState,
  type Tokenizer,
  type TreeSummary,
  type TreeSummaryNode,
} from '@hafiz/core'
import { z } from 'zod'
import { BLOCK_MARKER } from './sessions.js'
import { HafizToolError } from './tools.js'

/** The `task` argument naming the spawned block, and its value for a deliberately unmanaged spawn. */
export const BLOCK_ARG = 'block'
export const NO_BLOCK = 'none'

export const BLOCK_ARG_DESCRIPTION =
  'Id of the block the subagent works on (it sees that block in its own view), or "none" for a ' +
  'helper that works outside Hafiz (e.g. explore). Hafiz role agents always need a block.'

/** Kilo's `task` result: `<task id=… state="completed">…<task_result>…</task_result>`. */
export const TASK_RESULT =
  /<task id="([^"]+)" state="completed">\n(?:<summary>[\s\S]*?<\/summary>\n)?<task_result>\n?([\s\S]*?)\n?<\/task_result>/

/** The handback line for a child that may finish its block and did not, nor said what blocks it. */
export const UNFINISHED =
  'ended without a done request or a blocked entry: the block is not finished; read the report, then spawn a worker on it again or record what blocks it'

const REPORT = /```hafiz-report\n[\s\S]*?\n```/g

/** The sessions the checks consult; SessionRegistry in the plugin, a fake in tests. */
export interface CheckSessions {
  isManaged(id: string): boolean
  get(id: string): Readonly<{ role?: string; block?: string; focus?: string[] }> | undefined
  isRoleAgent(agent: string | undefined): boolean
  roleFor(
    agent: string | undefined,
    where: { subagent?: boolean; block?: string },
  ): string | undefined
  call<T>(id: string, method: string, params?: Record<string, unknown>): Promise<T>
}

export interface ChecksOptions {
  config: Config
  /** `project.storeDir`: the shell never touches it. */
  storeDir: string
  sessions: CheckSessions
  tokenizer?: Tokenizer
}

/** What a refused spawn says about the block, by its state. */
const STATE_SAYS: Record<SpawnState, string> = {
  no_design: 'it has no design yet, so the designer goes first',
  no_plan: 'it has a design but no plan yet, so the planner goes next',
  has_plan: 'it is planned',
  done: 'it is done; reopen it first (hafiz_block_set_status active, with a reason)',
  dropped: 'it is dropped',
}

/**
 * The block's state for spawning. `held`: the doc a `gate` review holds (design or plan); until
 * it is accepted the block counts as not having it, so only the roles before it may be spawned.
 */
export function spawnState(
  node: Pick<TreeSummaryNode, 'status' | 'docs'>,
  held?: ReviewType,
): SpawnState {
  if (node.status === 'done' || node.status === 'dropped') return node.status
  if (!node.docs.design || held === 'design') return 'no_design'
  if (!node.docs.plan || held === 'plan') return 'no_plan'
  return 'has_plan'
}

/** What a refused spawn says about a gated review: what waits, and the fix. */
function reviewSays(
  node: TreeSummaryNode,
  g: NonNullable<ReturnType<typeof gatingReview>>,
): string {
  const doc = `${g.type} of ${node.title} (v${g.review.version})`
  if (g.review.status === 'pending')
    return `${doc} awaits review: hafiz review --accept ${g.review.proposal}`
  const why = g.review.resolutionNote ? `: ${g.review.resolutionNote}` : ''
  return `${doc} was rejected${why}; revise it (it is filed for review again)`
}

type Fields = Record<string, { annotate?: (a: Record<string, unknown>) => unknown }>
interface SchemaLike {
  /** Effect Schema Struct (Kilo's built-in tools). */
  fields?: Fields
  mapFields?: (f: (fields: Fields) => Fields) => unknown
  /** Zod object. */
  _zod?: unknown
  extend?: (shape: Record<string, unknown>) => unknown
}

/** `parameters` with a required string `block` added, or undefined for a shape we do not know. */
function withBlockArg(parameters: unknown): unknown {
  const p = parameters as SchemaLike | undefined
  if (!p || typeof p !== 'object') return undefined
  const like = p.fields?.prompt
  if (typeof p.mapFields === 'function' && typeof like?.annotate === 'function') {
    const annotate = like.annotate.bind(like)
    return p.mapFields((f) => ({
      ...f,
      [BLOCK_ARG]: annotate({ description: BLOCK_ARG_DESCRIPTION }) as Fields[string],
    }))
  }
  if (p._zod && typeof p.extend === 'function')
    return p.extend({ [BLOCK_ARG]: z.string().describe(BLOCK_ARG_DESCRIPTION) })
  return undefined
}

function withBlockJson(schema: unknown): unknown {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] }
  if (!s || typeof s !== 'object' || !s.properties) return schema
  return {
    ...s,
    properties: {
      ...s.properties,
      [BLOCK_ARG]: { type: 'string', description: BLOCK_ARG_DESCRIPTION },
    },
    required: [...new Set([...(s.required ?? []), BLOCK_ARG])],
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function createChecks(o: ChecksOptions) {
  const { config, sessions } = o
  const tok = o.tokenizer ?? estimatorTokenizer
  const cap = config.hafiz.host.kilo.delegation_prompt_cap
  const extended = new WeakMap<object, unknown>()
  const refuse = (text: string): never => {
    throw new HafizToolError(text)
  }

  /** The block `ref` names, resolved as the parent sees the tree. */
  async function resolve(
    parent: string,
    ref: string,
  ): Promise<{ node: TreeSummaryNode; children: TreeSummaryNode[] }> {
    const { nodes } = await sessions.call<TreeSummary>(parent, 'tree.summary', {
      recentDecisions: 0,
    })
    const m = matchBlock(nodes, ref)
    if ('id' in m)
      return {
        node: nodes.find((n) => n.id === m.id) as TreeSummaryNode,
        children: nodes.filter((n) => n.parentId === m.id),
      }
    if ('ambiguous' in m)
      return refuse(`task: block '${ref}' is ambiguous (${m.by}):\n${blockList(m.ambiguous)}`)
    return refuse(`task: no block '${ref}'. Valid block ids:\n${blockList(nodes)}`)
  }

  async function task(parent: string, args: Record<string, unknown>): Promise<void> {
    const prompt = str(args.prompt)
    const agent = str(args.subagent_type)
    const ref = str(args[BLOCK_ARG]).trim()
    // A command's subtask: Kilo runs it for the user, the model chose no arguments.
    if (!ref && args.command !== undefined) return
    if (!ref)
      refuse(
        `task needs ${BLOCK_ARG}: the id of the block the subagent works on, or "${NO_BLOCK}".`,
      )
    if (ref === NO_BLOCK) {
      if (sessions.isRoleAgent(agent))
        refuse(
          `task: ${agent} is a Hafiz role agent and always works on a block; pass its block id (${BLOCK_ARG}: "${NO_BLOCK}" is for helpers outside Hafiz).`,
        )
      if (prompt.includes('<hafiz'))
        refuse(
          'task: the prompt quotes Hafiz context (<hafiz…>); a helper outside Hafiz gets the task only.',
        )
      return
    }
    if (prompt.includes('<hafiz'))
      refuse(
        'task: the prompt quotes Hafiz context (<hafiz…>). The subagent already sees its block in its own view: pass the block, not its contents.',
      )
    const size = tok.count(prompt)
    if (size > cap)
      refuse(
        `task: the prompt is ${size} tokens (cap ${cap}). The subagent already sees its block (design, plan, logs, interfaces): pass the block, and only the user's latest wishes and the task's scope.`,
      )
    const role = sessions.roleFor(agent, { subagent: true, block: ref })
    if (!role)
      refuse(
        `task: '${agent}' is not managed by Hafiz here, so it cannot work on a block; pass ${BLOCK_ARG}: "${NO_BLOCK}".`,
      )
    const { node, children } = await resolve(parent, ref)
    const gate = gatingReview(config.policies.review, node.review)
    const state = spawnState(node, gate?.type)
    const allowed = config.policies.spawn.roles_by_state[state] ?? []
    const open = children.filter((c) => c.status !== 'done' && c.status !== 'dropped')
    const says =
      gate && state !== spawnState(node)
        ? reviewSays(node, gate)
        : state === 'no_plan' && open.length
          ? `its work is in its children (${open.map((c) => `${c.title} [${c.id}]`).join(', ')}): spawn on those; it has no plan of its own yet (the planner writes one only for integration)`
          : STATE_SAYS[state]
    if (!allowed.includes('*') && !allowed.includes(role as string))
      refuse(
        `task: no ${role} on ${node.title} [${node.id}]: ${says}. ${
          allowed.length
            ? `Can be spawned on it now: ${allowed.join(', ')}.`
            : 'Nobody can be spawned on it.'
        }`,
      )
    // The marker carries the block to the child's session (sessions.open), whatever the model wrote.
    args.prompt = `hafiz:block=${node.id}\n${prompt.replace(new RegExp(BLOCK_MARKER, 'g'), '').trim()}`
  }

  function bash(args: Record<string, unknown>): void {
    const command = str(args.command)
    if (o.storeDir && command.includes(o.storeDir))
      refuse(
        `bash: this command touches the Hafiz store (${o.storeDir}). Read and write project memory with your hafiz_* tools, never the shell.`,
      )
  }

  /** May this role ask for its block to be done (then it should have, or said what blocks it)? */
  const finishes = (role: string | undefined) => {
    const allow = (role && config.roles.roles[role]?.tools) || []
    return isAllowed(allow, 'block.request_done') || isAllowed(allow, 'block.set_status', 'done')
  }

  return {
    /** `tool.definition`: Kilo's `task` gets the required `block` argument. */
    definition(toolID: string, out: { parameters: unknown; jsonSchema?: unknown }): void {
      if (toolID !== 'task') return
      const params = out.parameters
      if (params && typeof params === 'object') {
        if (!extended.has(params)) extended.set(params, withBlockArg(params))
        const p = extended.get(params)
        if (p) out.parameters = p
      }
      if (out.jsonSchema) out.jsonSchema = withBlockJson(out.jsonSchema)
    },

    /** `tool.execute.before`: veto (throw) or amend the call. Managed sessions only. */
    async before(
      input: { tool: string; sessionID: string },
      out: { args: unknown },
    ): Promise<void> {
      if (!sessions.isManaged(input.sessionID)) return
      const args = (out.args ?? {}) as Record<string, unknown>
      if (input.tool === 'task') await task(input.sessionID, args)
      else if (input.tool === 'bash') bash(args)
    },

    /**
     * The `task` output the managed parent reads, for a managed child whose final text was
     * stored on block `storedOn`: only its `hafiz-report` (or a note that it has none), and a
     * line when a child that may finish its block ended without a done request or a blocked entry.
     */
    async handback(child: string, output: string, storedOn: string | undefined): Promise<string> {
      const m = TASK_RESULT.exec(output)
      if (!m) return output
      const text = m[2] as string
      const lines: string[] = []
      const report = [...text.matchAll(REPORT)].pop()?.[0]
      if (report && storedOn) lines.push(report)
      else {
        lines.push(text)
        if (!report)
          lines.push(
            storedOn
              ? `no hafiz-report in this result; full text stored on block ${storedOn}`
              : 'no hafiz-report in this result',
          )
      }
      if (finishes(sessions.get(child)?.role)) {
        const done = await sessions
          .call<{ commands: string[] }>(child, 'session.activity')
          .then((a) => a.commands)
          .catch(() => undefined)
        const says = (c: string) =>
          [
            'block.request_done',
            'block.set_status:done',
            'progress.append:blocked',
            'block.set_status:blocked',
          ].includes(c)
        if (done && !done.some(says)) lines.push(UNFINISHED)
      }
      const start = (m.index as number) + m[0].indexOf('<task_result>') + '<task_result>'.length
      const end = (m.index as number) + m[0].length - '</task_result>'.length
      return `${output.slice(0, start)}\n${lines.join('\n')}\n${output.slice(end)}`
    },
  }
}

export type Checks = ReturnType<typeof createChecks>
