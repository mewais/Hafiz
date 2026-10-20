// A role-scoped MCP server in front of one daemon session. Role = server instance: only the
// tools the role's allowlist permits are registered, so a worker never sees `block_set_status:done`.
import { randomBytes } from 'node:crypto'
import {
  type Config,
  loadConfig,
  type ResolvedProject,
  resolveProject,
  rulesFor,
  toolName,
  toolsForRole,
} from '@hafiz/core'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type DaemonClient, type EnsureDaemonOptions, ensureDaemon } from '../daemon/client.js'
import { type DaemonCall, runTool } from '../tools/run.js'

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

  const call: DaemonCall = (method, params) => client.call(method, params)
  const confirm = async (message: string) => {
    if (!server.server.getClientCapabilities()?.elicitation) return undefined
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
    return r.action === 'accept' && r.content?.confirm === true
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
        const r = await runTool(call, rt, args, { confirm })
        return text(r.text, r.isError)
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

  for (const name of Object.keys(config.roles.roles)) {
    const rules = rulesFor(config, name)
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
  worktree?: string,
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
    ...(worktree ? { worktree } : {}),
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
  await attachSession(client, opts.role, opts.env, project.worktree)
  const { server } = createMcpServer({ role: opts.role, client, config })
  const done = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve()
  })
  await server.connect(new StdioServerTransport())
  await done
  client.close()
}
