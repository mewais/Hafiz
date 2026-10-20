// The `config` hook's job: register role agents and per-agent Hafiz tool permissions (native
// plugin tools by default; role MCP servers with `host.kilo.tools: mcp`), slash commands, store
// deny rules and compaction settings, and (proxy shaper) re-point provider base URLs. Pure apart
// from the `wrap` callback; user-provided entries win over ours.
import { type Config, rulesFor } from '@hafiz/core'
import type { KiloConfig } from './kilo.js'
import { toolNamesForRole } from './tools.js'

export type KiloToolsMode = 'native' | 'mcp'

export interface InstallPlan {
  config: Config
  repoRoot: string
  storeDir: string
  /** argv prefix that runs the `hafiz` CLI (e.g. [node, /path/bin.js]). */
  hafiz: string[]
  /** Extra environment for the MCP server processes. */
  env?: Record<string, string>
  /** Override `host.kilo.tools`. */
  tools?: KiloToolsMode
  /** Proxy: returns the base URL to use instead of `baseURL` for provider `id`. */
  wrap?: (id: string, baseURL: string) => string
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Hafiz manager: runs the block tree, delegates designer/planner/worker subagents',
  designer: 'Hafiz designer: writes and revises block designs',
  planner: 'Hafiz planner: breaks designed blocks into plans and child blocks',
  worker: 'Hafiz worker: implements one block; spawn with hafiz:block=<id> in the prompt',
}

/** Roles that get a Kilo agent (the `user` role is the human's CLI). */
export function agentRoles(config: Config): string[] {
  return Object.keys(config.roles.roles).filter((r) => r !== 'user')
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

type Rule = string | Record<string, string>

/** Add `pattern: deny` to a permission rule, keeping what was there. */
function denyPattern(rule: unknown, pattern: string): Rule {
  if (typeof rule === 'string') return { '*': rule, [pattern]: 'deny' }
  if (rule && typeof rule === 'object')
    return { ...(rule as Record<string, string>), [pattern]: 'deny' }
  return { [pattern]: 'deny' }
}

function storeDenies(storeDir: string, base: Record<string, unknown> = {}) {
  const glob = `${storeDir}/**`
  return {
    read: denyPattern(base.read, glob),
    edit: denyPattern(base.edit, glob),
    external_directory: denyPattern(base.external_directory, glob),
  }
}

/** Kilo's built-in subagents; they get `default_subagent_role`'s tools (used only with a marker). */
export const KILO_BUILTIN_SUBAGENTS = ['general', 'explore'] as const

type PermMap = Record<string, unknown>

/**
 * The `hafiz*` part of a role's permission map. Last match wins in Kilo, so the deny comes
 * first. Native tools use the unprefixed `hafiz_*`: Kilo copies a parent agent's denies into the
 * subagents it spawns only for MCP-server-prefixed patterns (and a fixed set of built-in tools),
 * so each subagent keeps exactly its own role's allow list.
 */
export function rolePermission(config: Config, role: string, mode: KiloToolsMode): PermMap {
  if (mode === 'mcp') return { 'hafiz-*': 'deny', [`hafiz-${role}_*`]: 'allow' }
  return {
    'hafiz_*': 'deny',
    ...Object.fromEntries(toolNamesForRole(config, role).map((n) => [n, 'allow'])),
  }
}

const denyAll = (mode: KiloToolsMode): PermMap =>
  mode === 'mcp' ? { 'hafiz-*': 'deny' } : { 'hafiz_*': 'deny' }

const activeRole = (config: Config, r: string | undefined) =>
  r && r !== 'none' && config.roles.roles[r] ? r : undefined

/**
 * Put our entries after the user's generic ones (so a user `'*': 'ask'` cannot re-open what we
 * deny), and the user's own `hafiz*` entries and same-key entries after ours (so they still win).
 */
function layer(base: PermMap, ours: PermMap): PermMap {
  const theirsWins = (k: string) => k in ours || k.startsWith('hafiz')
  const out: PermMap = {}
  for (const [k, v] of Object.entries(base)) if (!theirsWins(k)) out[k] = v
  Object.assign(out, ours)
  for (const [k, v] of Object.entries(base))
    if (theirsWins(k)) {
      delete out[k]
      out[k] = v
    }
  return out
}

const asMap = (perm: unknown): PermMap =>
  typeof perm === 'string' ? { '*': perm } : { ...((perm as PermMap | undefined) ?? {}) }

export function installConfig(cfg: KiloConfig, plan: InstallPlan): void {
  const { config } = plan
  const mode: KiloToolsMode = plan.tools ?? config.hafiz.host.kilo.tools
  const roles = agentRoles(config)
  const defaultRole = activeRole(config, config.hafiz.host.kilo.default_role)
  const subagentRole = activeRole(config, config.hafiz.host.kilo.default_subagent_role)

  // MCP mode only: one server per role. Kilo names their tools `hafiz-<role>_hafiz_<command>`.
  // Native mode registers the tools through the plugin `tool` hook instead (tools.ts).
  if (mode === 'mcp') {
    cfg.mcp ??= {}
    for (const role of roles) {
      const name = `hafiz-${role}`
      if (cfg.mcp[name]) continue
      cfg.mcp[name] = {
        type: 'local',
        command: [...plan.hafiz, 'mcp', '--role', role, '--project', plan.repoRoot],
        environment: {
          HAFIZ_HOST: 'kilo',
          HAFIZ_AGENT: role,
          // Kilo starts one MCP process per server, shared by every session of that role.
          HAFIZ_SESSION_ID: `kilo-mcp-${role}`,
          ...plan.env,
        },
        enabled: true,
      }
    }
  }

  // Role agents: prompt = rules, tools = exactly the role's allowlist.
  cfg.agent ??= {}
  const nonRoleSubagents = new Set<string>(KILO_BUILTIN_SUBAGENTS)
  for (const [name, a] of Object.entries(cfg.agent))
    if (a?.mode === 'subagent' && !roles.includes(name)) nonRoleSubagents.add(name)
  for (const role of roles) {
    const ours: Record<string, unknown> = {
      description: ROLE_DESCRIPTIONS[role] ?? `Hafiz ${role}`,
      mode: role === 'manager' ? 'primary' : 'subagent',
      prompt: rulesFor(config, role),
    }
    const theirs = cfg.agent[role] ?? {}
    const perm = layer(asMap(theirs.permission), {
      ...rolePermission(config, role, mode),
      task: role === 'manager' ? 'allow' : 'deny',
    })
    cfg.agent[role] = {
      ...ours,
      ...theirs,
      permission: { ...perm, ...storeDenies(plan.storeDir, perm) },
    }
  }

  // Non-Hafiz subagents (general, explore, custom): the default subagent role's tools. They
  // become managed only when spawned with hafiz:block=<id>; otherwise a call is refused.
  for (const name of nonRoleSubagents) {
    const theirs = cfg.agent[name] ?? {}
    const ours = subagentRole ? rolePermission(config, subagentRole, mode) : denyAll(mode)
    cfg.agent[name] = { ...theirs, permission: layer(asMap(theirs.permission), ours) }
  }

  // Global: every other agent (build, plan, custom primaries) gets the default role's tools,
  // or none; nobody touches the store.
  const base = asMap(cfg.permission)
  const global = layer(
    base,
    defaultRole ? rolePermission(config, defaultRole, mode) : denyAll(mode),
  )
  cfg.permission = { ...global, ...storeDenies(plan.storeDir, base) }

  // Hafiz owns the tail in managed projects; Kilo's own compaction would summarise it away.
  cfg.compaction = { ...(cfg.compaction ?? {}), auto: false }

  // Slash commands.
  cfg.command ??= {}
  const cli = plan.hafiz.map(shellQuote).join(' ')
  cfg.command['hafiz-status'] ??= {
    description: 'Hafiz: project status (epoch, sessions, pending proposals)',
    template: `Hafiz project status:\n\n!\`${cli} status\`\n\nSummarise this for the user in a few lines. Do not call tools.`,
  }
  cfg.command['hafiz-checkpoint'] ??= {
    description: 'Hafiz: record unrecorded work from this conversation',
    // TODO(M5): also trigger condensation of the verbatim tail (CondensationDue).
    template:
      'Checkpoint. Record in Hafiz anything from this conversation the store does not hold yet: ' +
      'progress for work done, decisions taken, threads to open or park. Use your hafiz tools, ' +
      'one small entry per item. Then reply with one line listing what you recorded.',
  }

  // Proxy shaper: re-point every provider that names its own base URL.
  if (plan.wrap)
    for (const [id, p] of Object.entries(cfg.provider ?? {})) {
      const url = p?.options?.baseURL
      if (p?.options && typeof url === 'string' && /^https?:\/\//.test(url))
        p.options.baseURL = plan.wrap(id, url)
    }
}
