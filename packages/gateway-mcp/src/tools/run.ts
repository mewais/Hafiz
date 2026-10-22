// Executes one catalogue tool against the daemon and renders the text the agent sees. Shared by
// the MCP gateway and the Kilo plugin's native tools, so both answer the same way. The tool's
// catalogue entry routes the call to one Core command or query (`routeTool`); this file only
// runs it. The caller supplies `call`, which carries the session's token (a DaemonClient holding
// it, or an explicit per-session token on a shared connection).
import type {
  CommandResult,
  ContextView,
  DeltaResult,
  Explanation,
  Proposal,
  RoleTool,
} from '@hafiz/core'
import { HafizError, routeTool, suggestedCommand } from '@hafiz/core'
import { RpcError } from '../daemon/rpc.js'
import type { QueuedNotice } from '../daemon/service.js'

export type DaemonCall = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>

export interface RunToolOptions {
  /**
   * Asked when a command answers `needsConfirmation` (e.g. marking done under
   * `review.done: gate`). Resolve true to retry with `confirmed: true`; undefined → the message
   * is returned to the agent, which asks the user itself.
   */
  confirm?: (message: string) => Promise<boolean | undefined>
}

export interface ToolOutcome {
  text: string
  isError: boolean
}

function isNeedsConfirmation(r: unknown): r is { needsConfirmation: true; message: string } {
  return (
    typeof r === 'object' &&
    r !== null &&
    (r as { needsConfirmation?: unknown }).needsConfirmation === true
  )
}

async function body(
  call: DaemonCall,
  rt: RoleTool,
  args: Record<string, unknown>,
  opts: RunToolOptions,
): Promise<string> {
  const { command, args: a } = routeTool(rt, args)
  switch (command) {
    case 'context.for': {
      const v = await call<ContextView>('context.for', a)
      const meta = `[view ${v.hash} · ${v.tokens}/${v.budget} tokens · ${v.changed ? 'changed' : 'unchanged'}]`
      return [v.text, v.floorText, ...v.notices.map((n) => `${n.level}: ${n.text}`), meta]
        .filter(Boolean)
        .join('\n\n')
    }
    case 'context.explain':
      return JSON.stringify(await call<Explanation>('context.explain', a), null, 1)
    case 'context.delta':
      return JSON.stringify(await call<DeltaResult>('context.delta'))
    case 'block.read':
      return call<string>('block.read', a)
    case 'tree.list':
      return (
        await call<
          Array<{ id: string; title: string; kind: string; status: string; depth: number }>
        >('tree.list')
      )
        .map((b) => `${'  '.repeat(b.depth)}[${b.status}] ${b.id} — ${b.title} (${b.kind})`)
        .join('\n')
    case 'session.status':
      return JSON.stringify(await call('session.status'))
    case 'proposal.list':
      // Each entry says where it came from and what accepting it would run.
      return JSON.stringify(
        (await call<Proposal[]>('proposal.list', a.status ? { status: a.status } : {})).map(
          (p) => ({ ...p, suggested: suggestedCommand(p) }),
        ),
      )
    default: {
      let out = await call<CommandResult>('dispatch', { command, args: a })
      if (isNeedsConfirmation(out.result)) {
        const { message } = out.result
        const yes = opts.confirm ? await opts.confirm(message) : undefined
        if (yes === undefined) return message
        if (!yes) return 'The user did not confirm; nothing was changed.'
        out = await call<CommandResult>('dispatch', { command, args: { ...a, confirmed: true } })
      }
      const lines = [JSON.stringify(out.result ?? null)]
      for (const n of out.notices) lines.push(`${n.level}: ${n.text}`)
      return lines.join('\n')
    }
  }
}

/**
 * Run one tool. Daemon errors (authz, validation, conflicts) come back as `isError` text the
 * agent can act on; transport failures throw. Counters and queued notices ride along and never
 * fail the call.
 */
export async function runTool(
  call: DaemonCall,
  rt: RoleTool,
  args: Record<string, unknown>,
  opts: RunToolOptions = {},
): Promise<ToolOutcome> {
  let text: string
  try {
    text = await body(call, rt, args, opts)
  } catch (e) {
    if (e instanceof RpcError)
      return { text: `${e.message}${e.data ? `\n${JSON.stringify(e.data)}` : ''}`, isError: true }
    // the call did not fit the tool (routeTool): nothing reached the daemon
    if (e instanceof HafizError) return { text: e.message, isError: true }
    throw e
  }
  await call('counters.add', { delta: { tool_calls_hafiz: 1 } }).catch(() => undefined)
  const queued = await call<QueuedNotice[]>('notices.drain').catch(() => [] as QueuedNotice[])
  return { text: [text, ...queued.map((n) => `[${n.event}] ${n.text}`)].join('\n'), isError: false }
}
