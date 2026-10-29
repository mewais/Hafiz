// The command catalogue: every Core command and query a gateway can reach, and the hooks Core
// runs around a dispatched command. The CLI, the daemon and the tests use commands directly; the
// agent-facing tools (tools.ts) are fewer and coarser, and each tool call routes to one of these.

/** One Core command or query. */
export interface CommandSpec {
  /** Core command or query, e.g. `block.set_status`. */
  command: string
  /** `dispatch` goes through Core.dispatch; `query` has its own daemon method. */
  kind: 'dispatch' | 'query'
  /** Hooks Core runs before the command when it is dispatched (commands/hooks.ts). */
  before?: readonly BeforeHook[]
  /** Hooks Core runs after the command succeeds when it is dispatched, in order. */
  after?: readonly AfterHook[]
}

/**
 * Before-hooks (commands/hooks.ts):
 * - `draft_gist`: parking a thread without a gist (drafters on) is refused with a drafted gist.
 */
export type BeforeHook = 'draft_gist'

/**
 * After-hooks (commands/hooks.ts):
 * - `refresh_focus`: re-compute every live agent's computed focus that is now stale.
 * - `announce_proposals`: tell the gateway new proposals may be pending review.
 * - `done_compliance`: a request to finish a block (`request_done`, `set_status` → done) runs
 *   the `request_done` compliance checks; their notices join the reply.
 * - `draft_digest`: the same request with a thin digest queues a drafted one (drafters on).
 * - `announce_resolution`: a design/plan review accepted or rejected, or any proposal rejected
 *   with a note, is told to the reviewers (the manager).
 */
export type AfterHook =
  | 'refresh_focus'
  | 'announce_proposals'
  | 'done_compliance'
  | 'draft_digest'
  | 'announce_resolution'

/** After any write that can change a block's status or the review queue. */
const TREE_WRITE: readonly AfterHook[] = ['refresh_focus', 'announce_proposals']
/** After resolving a proposal. */
const RESOLVE_WRITE: readonly AfterHook[] = [...TREE_WRITE, 'announce_resolution']
/** After a request to finish a block. */
const DONE_WRITE: readonly AfterHook[] = [...TREE_WRITE, 'done_compliance', 'draft_digest']

const query = (command: string): CommandSpec => ({ command, kind: 'query' })
const write = (command: string, hooks: Omit<CommandSpec, 'command' | 'kind'> = {}) => ({
  command,
  kind: 'dispatch' as const,
  ...hooks,
})

export const COMMAND_SPECS: readonly CommandSpec[] = [
  query('context.for'),
  query('context.explain'),
  query('context.delta'),
  query('block.read'),
  query('tree.list'),
  query('session.status'),
  query('proposal.list'),
  write('proposal.accept', { after: RESOLVE_WRITE }),
  write('proposal.reject', { after: RESOLVE_WRITE }),
  write('block.create', { after: TREE_WRITE }),
  write('block.update', { after: TREE_WRITE }),
  write('block.move', { after: TREE_WRITE }),
  write('block.set_status', { after: DONE_WRITE }),
  write('block.request_done', { after: DONE_WRITE }),
  write('edge.add'),
  write('edge.remove'),
  // a design or plan write files its review in the write's transaction (review.ts); announce it
  write('doc.write', { after: ['announce_proposals'] }),
  write('doc.patch', { after: ['announce_proposals'] }),
  write('progress.append'),
  write('decision.record'),
  write('thread.open'),
  write('thread.park', { before: ['draft_gist'] }),
  write('thread.resume'),
  write('thread.resolve'),
  write('thread.append'),
  write('focus.set'),
]

export const commandSpec = (command: string): CommandSpec | undefined =>
  COMMAND_SPECS.find((c) => c.command === command)
