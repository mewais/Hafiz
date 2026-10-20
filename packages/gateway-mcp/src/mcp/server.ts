// A role-scoped MCP server in front of one daemon session. Role = server instance: only the
// tools the role's allowlist permits are registered, so a worker never sees `block_set_status:done`.
import { randomBytes } from 'node:crypto'
import { type Config, loadConfig, type ResolvedProject, resolveProject } from '@hafiz/core'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type DaemonClient, type EnsureDaemonOptions, ensureDaemon } from '../daemon/client.js'
import { RpcError } from '../daemon/rpc.js'
import { type RoleTool, toCoreArgs, toolName, toolsForRole } from './tools.js'

export interface McpServerOptions {
  role: string
  /** A client that already holds this session's token. */
  client: DaemonClient
  config?: Config
}

export interface HafizMcp {
  server: McpServer
  /** Registered tool names, in registration order. */
  tools: string[]
}

const text = (t: string, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: t }],
  ...(isError ? { isError: true } : {}),
})

function isNeedsConfirmation(r: unknown): r is { needsConfirmation: true; message: string } {
  return (
    typeof r === 'object' &&
    r !== null &&
    (r as { needsConfirmation?: unknown }).needsConfirmation === true
  )
}

export function createMcpServer(opts: McpServerOptions): HafizMcp {
  const config = opts.config ?? loadConfig()
  const { client, role } = opts
  const roleTools = toolsForRole(config, role)
  const can = (command: string) => roleTools.some((t) => t.spec.command === command)

  const server = new McpServer(
    { name: `hafiz-${role}`, version: '0.0.0' },
    {
      instructions: `Hafiz is this project's shared memory: a block tree with designs, plans, logs and decisions. You are the ${role}. Call hafiz_context_for first; keep writes small and structured.`,
    },
  )

  /** Run one tool against the daemon and return the payload to show the agent. */
  async function invoke(rt: RoleTool, args: Record<string, unknown>): Promise<string> {
    const { command } = rt.spec
    const a = toCoreArgs(args)
    switch (command) {
      case 'context.for': {
        const v = await client.contextFor(a)
        const meta = `[view ${v.hash} · ${v.tokens}/${v.budget} tokens · ${v.changed ? 'changed' : 'unchanged'}]`
        return [v.text, v.floorText, ...v.notices.map((n) => `${n.level}: ${n.text}`), meta]
          .filter(Boolean)
          .join('\n\n')
      }
      case 'context.explain':
        return JSON.stringify(await client.contextExplain(a.block as string, a), null, 1)
      case 'context.delta':
        return JSON.stringify(await client.contextDelta())
      case 'block.read':
        return client.blockRead(a.id as string, a.zoom as string | undefined)
      case 'tree.list':
        return (await client.treeList())
          .map((b) => `${'  '.repeat(b.depth)}[${b.status}] ${b.id} — ${b.title} (${b.kind})`)
          .join('\n')
      case 'session.status':
        return JSON.stringify(await client.sessionStatus())
      case 'proposal.list':
        return JSON.stringify(await client.proposalList(a.status as never))
      default:
        return dispatch(command, a)
    }
  }

  async function dispatch(command: string, a: Record<string, unknown>): Promise<string> {
    let out = await client.dispatch(command, a)
    if (isNeedsConfirmation(out.result)) {
      const { message } = out.result
      if (!server.server.getClientCapabilities()?.elicitation) return message
      const r = await server.server.elicitInput({
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Confirm', description: 'Yes, go ahead' },
          },
          required: ['confirm'],
        },
      })
      if (r.action !== 'accept' || r.content?.confirm !== true)
        return 'The user did not confirm; nothing was changed.'
      out = await client.dispatch(command, { ...a, confirmed: true })
    }
    const lines = [JSON.stringify(out.result ?? null)]
    for (const n of out.notices) lines.push(`${n.level}: ${n.text}`)
    return lines.join('\n')
  }

  for (const rt of roleTools) {
    const { spec } = rt
    server.registerTool(
      toolName(spec.command),
      {
        description: spec.description(config),
        inputSchema: spec.shape(config, rt.qualifiers),
        annotations: { readOnlyHint: spec.readOnly === true },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        let body: string
        try {
          body = await invoke(rt, args)
        } catch (e) {
          if (e instanceof RpcError)
            return text(`${e.message}${e.data ? `\n${JSON.stringify(e.data)}` : ''}`, true)
          throw e
        }
        // Instrumentation and queued events ride along; neither may fail the call.
        await client.countersAdd({ tool_calls_hafiz: 1 }).catch(() => undefined)
        const queued = await client.noticesDrain().catch(() => [])
        const extra = queued.map((n) => `[${n.event}] ${n.text}`)
        return text([body, ...extra].join('\n'))
      },
    )
  }

  if (can('context.for'))
    server.registerResource(
      'context',
      'hafiz://context',
      {
        title: 'Project context',
        description: 'Your current context view.',
        mimeType: 'text/plain',
      },
      async (uri) => {
        const v = await client.contextFor()
        return {
          contents: [{ uri: uri.href, text: [v.text, v.floorText].filter(Boolean).join('\n\n') }],
        }
      },
    )
  if (can('block.read'))
    server.registerResource(
      'block',
      new ResourceTemplate('hafiz://block/{id}', { list: undefined }),
      {
        title: 'Block (design zoom)',
        description: 'One block at DESIGN zoom.',
        mimeType: 'text/plain',
      },
      async (uri, vars) => {
        const id = decodeURIComponent(String(vars.id))
        return { contents: [{ uri: uri.href, text: await client.blockRead(id, 'DESIGN') }] }
      },
    )

  for (const [name, def] of Object.entries(config.roles.roles)) {
    const rules = config.rules[def.rules] ?? ''
    server.registerPrompt(
      `hafiz_${name}`,
      { title: `Hafiz ${name} rules`, description: `Operating rules for the ${name} role.` },
      () => ({ messages: [{ role: 'user', content: { type: 'text', text: rules } }] }),
    )
  }

  return { server, tools: roleTools.map((t) => toolName(t.spec.command)) }
}

// ───────────────────────────── session bootstrap ─────────────────────────────

/** Open or adopt the session described by the environment (see docs/ARCHITECTURE.md §11.1). */
export async function attachSession(
  client: DaemonClient,
  role: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.HAFIZ_TOKEN) {
    client.token = env.HAFIZ_TOKEN // adapter-minted: the session already exists
    return
  }
  await client.openSession({
    id: env.HAFIZ_SESSION_ID || `mcp_${randomBytes(6).toString('hex')}`,
    host: env.HAFIZ_HOST || 'mcp',
    role,
    ...(env.HAFIZ_AGENT ? { agent: env.HAFIZ_AGENT } : {}),
    ...(env.HAFIZ_PARENT_SESSION ? { parentSessionId: env.HAFIZ_PARENT_SESSION } : {}),
    ...(env.HAFIZ_BLOCK ? { spawnedBlock: env.HAFIZ_BLOCK } : {}),
  })
}

export interface RunMcpOptions {
  role: string
  /** Directory inside the repo; default: cwd. */
  projectDir?: string | undefined
  cwd: string
  env: NodeJS.ProcessEnv
  daemon?: EnsureDaemonOptions
  project?: ResolvedProject
}

/** `hafiz mcp --role r`: serve MCP on stdio until the host closes it. */
export async function runMcpStdio(opts: RunMcpOptions): Promise<void> {
  const config = loadConfig()
  if (!config.roles.roles[opts.role])
    throw new Error(
      `unknown role '${opts.role}'. Known: ${Object.keys(config.roles.roles).join(', ')}`,
    )
  const project = opts.project ?? resolveProject(opts.projectDir ?? opts.cwd, opts.env)
  const client = await ensureDaemon(project, { env: opts.env, ...opts.daemon })
  await attachSession(client, opts.role, opts.env)
  const { server } = createMcpServer({ role: opts.role, client, config })
  const done = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
  })
  await server.connect(new StdioServerTransport())
  await done
  client.close()
}
