// Hafiz tools as Kilo plugin-native tools (`tool` hook). Unlike an MCP server, which Kilo runs
// once per instance, a native tool's execute() receives the calling Kilo session id, so every
// call is resolved to that session's own Hafiz session (role, parent, spawned block, token) and
// attributed correctly. Generated from the same catalogue the MCP gateway uses.
import { appendFileSync } from 'node:fs'
import {
  agentRoleNames,
  type Config,
  isAllowed,
  type RoleTool,
  roleTool,
  TOOL_SPECS,
  toolsForRole,
} from '@hafiz/core'
import { runTool } from '@hafiz/gateway-mcp'
import { z } from 'zod'
import type { KiloToolContext, KiloToolDefinition, KiloToolResult } from './kilo.js'
import type { SessionRegistry } from './sessions.js'

/** Roles any Kilo agent can be managed as: the role agents plus the two defaults. */
export function managedRoles(config: Config): string[] {
  const roles = agentRoleNames(config)
  const kilo = config.hafiz.host.kilo
  for (const r of [kilo.default_role, kilo.default_subagent_role])
    if (r && r !== 'none' && config.roles.roles[r] && !roles.includes(r)) roles.push(r)
  return roles
}

/** Native tool names a role may call (its allowlist through the catalogue). */
export function toolNamesForRole(config: Config, role: string): string[] {
  return toolsForRole(config, role, 'kilo').map((t) => t.spec.name)
}

/**
 * The definitions Kilo registers: plugin tools are global, so each catalogue tool is registered
 * once for every managed role that can use it, with the union of what those roles may do (enum
 * values, inputs, description sentences). execute() then routes each call with the caller's own
 * role, so a worker's `done` is still a request.
 */
export function registeredTools(config: Config): RoleTool[] {
  const allow = managedRoles(config).map((r) => config.roles.roles[r]?.tools ?? [])
  const can = (command: string, q?: string) => allow.some((p) => isAllowed(p, command, q))
  return TOOL_SPECS.filter((s) => !s.hosts || s.hosts.includes('kilo')).flatMap((s) => {
    const t = roleTool(config, s, can, true)
    return t ? [t] : []
  })
}

export class HafizToolError extends Error {}

export interface NativeToolsOptions {
  config: Config
  /** The registry, or a getter: undefined until an untracked repo starts being tracked. */
  sessions: SessionRegistry | (() => SessionRegistry | undefined)
  /**
   * A jsonl file that gets one line per write refused for size (`HAFIZ_REJECTION_LOG`, set by
   * the harness): role, block and each section with its measured size and cap.
   */
  rejectionLog?: string | undefined
}

/** The one tool an untracked git repo gets (primary agents only; see install.ts). */
export const TRACK_TOOL = 'hafiz_track_project'

export const TRACK_DESCRIPTION =
  'Start tracking this git repo with Hafiz: a shared project memory (block tree, designs, plans, ' +
  'progress) that keeps multi-step work and subagents coordinated across sessions. Call it ' +
  'yourself, without asking, when the task is multi-step or will spawn subagents; never for ' +
  'one-off tasks (a question, a small edit). Then tell the user in one line: ' +
  '"Tracking this repo with Hafiz as `<name>`".'

export function trackTool(
  execute: (
    args: { name: string; reason?: string },
    ctx: KiloToolContext,
  ) => Promise<KiloToolResult>,
): KiloToolDefinition {
  return {
    description: TRACK_DESCRIPTION,
    args: {
      name: z.string().min(1).max(80).describe('Short project name (the product or repo name)'),
      reason: z.string().max(300).optional().describe('One line: why this work is worth tracking'),
    },
    execute,
  }
}

/**
 * The `tool` hook map. Visibility per agent is Kilo's permission system (see install.ts);
 * execute() re-checks the caller's role and the daemon authorizes every call again.
 */
export function nativeTools(opts: NativeToolsOptions): Record<string, KiloToolDefinition> {
  const { config } = opts
  const registry = () => (typeof opts.sessions === 'function' ? opts.sessions() : opts.sessions)
  const tools: Record<string, KiloToolDefinition> = {}
  for (const all of registeredTools(config)) {
    const name = all.spec.name
    tools[name] = {
      description: all.spec.description(config, all),
      args: all.spec.shape(config, all),
      async execute(args: Record<string, unknown>, ctx: KiloToolContext) {
        const sid = ctx.sessionID
        const sessions = registry()
        if (!sessions)
          throw new HafizToolError(
            `${name}: Hafiz is not tracking this repo yet; call ${TRACK_TOOL} first.`,
          )
        const open = await sessions.open(sid, { agent: ctx.agent })
        const role = sessions.get(sid)?.role
        if (!open || !role)
          throw new HafizToolError(
            `${name}: this Kilo session is not managed by Hafiz (agent '${ctx.agent}'). Subagents are managed only when spawned on a block (the block argument of task).`,
          )
        const rt = toolsForRole(config, role, 'kilo').find((t) => t.spec.name === name)
        if (!rt) throw new HafizToolError(`${name} is not available to the ${role} role.`)
        const r = await runTool((m, p) => sessions.call(sid, m, p), rt, args)
        if (r.rejection && opts.rejectionLog) {
          const k = sessions.get(sid)
          const line = {
            ts: new Date().toISOString(),
            session: sid,
            role,
            block: args.block ?? args.id ?? k?.block,
            tool: name,
            ...r.rejection,
          }
          try {
            appendFileSync(opts.rejectionLog, `${JSON.stringify(line)}\n`)
          } catch {} // a diagnostics sink never fails the call
        }
        if (r.isError) throw new HafizToolError(r.text)
        return { title: name, output: r.text, metadata: { hafiz_role: role } }
      },
    }
  }
  return tools
}
