// Hafiz tools as Kilo plugin-native tools (`tool` hook). Unlike an MCP server, which Kilo runs
// once per instance, a native tool's execute() receives the calling Kilo session id, so every
// call is resolved to that session's own Hafiz session (role, parent, spawned block, token) and
// attributed correctly. Generated from the same catalogue the MCP gateway uses.
import {
  agentRoleNames,
  type Config,
  type RoleTool,
  TOOL_SPECS,
  type ToolSpec,
  toolName,
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
  return toolsForRole(config, role).map((t) => toolName(t.spec.command))
}

/** Catalogue entries at least one managed role can use, with the union of their qualifiers. */
function registeredSpecs(config: Config): RoleTool[] {
  const out = new Map<string, RoleTool>()
  for (const role of managedRoles(config))
    for (const rt of toolsForRole(config, role)) {
      const have = out.get(rt.spec.command)
      if (!have) out.set(rt.spec.command, { spec: rt.spec, qualifiers: [...rt.qualifiers] })
      else for (const q of rt.qualifiers) if (!have.qualifiers.includes(q)) have.qualifiers.push(q)
    }
  // Keep catalogue order so the tool list is stable.
  return TOOL_SPECS.flatMap((s: ToolSpec) => {
    const rt = out.get(s.command)
    return rt ? [rt] : []
  })
}

export class HafizToolError extends Error {}

export interface NativeToolsOptions {
  config: Config
  /** The registry, or a getter: undefined until an untracked repo starts being tracked. */
  sessions: SessionRegistry | (() => SessionRegistry | undefined)
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
  for (const all of registeredSpecs(config)) {
    const name = toolName(all.spec.command)
    tools[name] = {
      description: all.spec.description(config),
      args: all.spec.shape(config, all.qualifiers),
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
            `${name}: this Kilo session is not managed by Hafiz (agent '${ctx.agent}'). Subagents are managed only when their task prompt contains hafiz:block=<block id>.`,
          )
        const rt = toolsForRole(config, role).find((t) => t.spec.command === all.spec.command)
        if (!rt) throw new HafizToolError(`${name} is not available to the ${role} role.`)
        const r = await runTool((m, p) => sessions.call(sid, m, p), rt, args)
        if (r.isError) throw new HafizToolError(r.text)
        return { title: name, output: r.text, metadata: { hafiz_role: role } }
      },
    }
  }
  return tools
}
