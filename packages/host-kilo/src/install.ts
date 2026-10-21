// The `config` hook's job: register role agents and per-agent Hafiz tool permissions (native
// plugin tools by default; role MCP servers with `host.kilo.tools: mcp`), slash commands, store
// deny rules and compaction settings, and (proxy shaper) re-point provider base URLs. Pure apart
// from the `wrap` callback; user-provided entries win over ours, except that Hafiz's rules are
// always appended to a managed agent's own prompt, never replaced by it.
//
// Kilo builds an agent's system prompt from its `prompt` *instead of* the model-specific prompt
// it ships, so a prompt is set only where one exists already (a role agent, or a user's own
// `prompt` on an agent managed under the default role). Managed agents without one (`build` as
// shipped, subagents spawned on a block) get the rules ahead of the envelope from the shaper.
//
// In an untracked git repo (`untracked: true`) the same agents and permissions are installed up
// front, because Kilo reads both once at startup: tracking mid-session (hafiz_track_project) can
// then switch a session to managed mode without a restart. Until then the plugin hides every
// Hafiz tool but the track tool per request (plugin.ts). MCP servers and the compaction change
// are left out until a later start finds the project.
import { agentRoleNames, type Config, rulesFor } from '@hafiz/core'
import type { KiloConfig } from './kilo.js'
import { toolNamesForRole } from './tools.js'

export type KiloToolsMode = 'native' | 'mcp'

export interface InstallPlan {
  config: Config
  /** The working tree Kilo runs in (MCP servers resolve the project from it). */
  worktree: string
  /** The store to keep agents out of (untracked: the whole store root). */
  storeDir: string
  /** argv prefix that runs the `hafiz` CLI (e.g. [node, /path/bin.js]). */
  hafiz: string[]
  /** Extra environment for the MCP server processes. */
  env?: Record<string, string>
  /** Override `host.kilo.tools`. */
  tools?: KiloToolsMode
  /** Proxy: returns the base URL to use instead of `baseURL` for provider `id`. */
  wrap?: (id: string, baseURL: string) => string
  /** Untracked git repo: also allow `trackTool` to primary agents; no MCP servers, no compaction. */
  untracked?: { trackTool: string }
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Hafiz manager: runs the block tree, delegates designer/planner/worker subagents',
  designer: 'Hafiz designer: writes and revises block designs',
  planner: 'Hafiz planner: breaks designed blocks into plans and child blocks',
  worker: 'Hafiz worker: implements one block; spawn with hafiz:block=<id> in the prompt',
}

/** Roles that get a Kilo agent (not the roles a person plays: `user`, `viewer`). */
export function agentRoles(config: Config): string[] {
  return agentRoleNames(config)
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

/** Marks where Hafiz's rules start in an agent prompt. */
export const RULES_SEPARATOR = (role: string) =>
  `<!-- Hafiz ${role} rules, appended by the Hafiz plugin: edit rules/*.md in the Hafiz config, not here -->`

/** `prompt` followed by the role's rules: what every managed agent prompt ends with. */
export function withRules(config: Config, role: string, prompt?: unknown): string {
  const own = typeof prompt === 'string' ? prompt.trim() : ''
  const rules = `${RULES_SEPARATOR(role)}\n${rulesFor(config, role)}`
  return own ? `${own}\n\n${rules}` : rules
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

/**
 * Install Hafiz into Kilo's config. Returns the agents whose prompt now ends with Hafiz's rules
 * (the shaper injects them for any other managed agent).
 */
export function installConfig(cfg: KiloConfig, plan: InstallPlan): string[] {
  const { config } = plan
  const mode: KiloToolsMode = plan.tools ?? config.hafiz.host.kilo.tools
  const roles = agentRoles(config)
  const defaultRole = activeRole(config, config.hafiz.host.kilo.default_role)
  const subagentRole = activeRole(config, config.hafiz.host.kilo.default_subagent_role)

  // MCP mode only: one server per role. Kilo names their tools `hafiz-<role>_hafiz_<command>`.
  // Native mode registers the tools through the plugin `tool` hook instead (tools.ts).
  if (mode === 'mcp' && !plan.untracked) {
    cfg.mcp ??= {}
    for (const role of roles) {
      const name = `hafiz-${role}`
      if (cfg.mcp[name]) continue
      cfg.mcp[name] = {
        type: 'local',
        command: [...plan.hafiz, 'mcp', '--role', role, '--project', plan.worktree],
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

  // Role agents: prompt = the user's own prompt (if any) + rules, tools = exactly the role's
  // allowlist.
  // Untracked: primary agents (the manager agent, and others under the default role) may start
  // tracking; subagents never (their `hafiz_*` deny covers it).
  const track: PermMap = plan.untracked ? { [plan.untracked.trackTool]: 'allow' } : {}
  const noTrack: PermMap = plan.untracked ? { [plan.untracked.trackTool]: 'deny' } : {}

  cfg.agent ??= {}
  const nonRoleSubagents = new Set<string>(KILO_BUILTIN_SUBAGENTS)
  for (const [name, a] of Object.entries(cfg.agent))
    if (a?.mode === 'subagent' && !roles.includes(name)) nonRoleSubagents.add(name)
  for (const role of roles) {
    const ours: Record<string, unknown> = {
      description: ROLE_DESCRIPTIONS[role] ?? `Hafiz ${role}`,
      mode: role === 'manager' ? 'primary' : 'subagent',
    }
    const theirs = cfg.agent[role] ?? {}
    const perm = layer(asMap(theirs.permission), {
      ...rolePermission(config, role, mode),
      ...(role === 'manager' ? track : noTrack),
      task: role === 'manager' ? 'allow' : 'deny',
    })
    cfg.agent[role] = {
      ...ours,
      ...theirs,
      prompt: withRules(config, role, theirs.prompt),
      permission: { ...perm, ...storeDenies(plan.storeDir, perm) },
    }
  }
  const prompted = [...roles]

  // Primary agents managed under the default role that carry their own prompt: append the rules
  // (tracked only: in an untracked repo they are not managed until tracking starts).
  if (defaultRole && !plan.untracked)
    for (const [name, a] of Object.entries(cfg.agent)) {
      if (roles.includes(name) || a?.mode === 'subagent' || typeof a?.prompt !== 'string') continue
      if (a.hidden || a.disable || !a.prompt.trim()) continue
      cfg.agent[name] = { ...a, prompt: withRules(config, defaultRole, a.prompt) }
      prompted.push(name)
    }

  // Non-Hafiz subagents (general, explore, custom): the default subagent role's tools. They
  // become managed only when spawned with hafiz:block=<id>; otherwise a call is refused.
  for (const name of nonRoleSubagents) {
    const theirs = cfg.agent[name] ?? {}
    const ours = {
      ...(subagentRole ? rolePermission(config, subagentRole, mode) : denyAll(mode)),
      ...noTrack,
    }
    cfg.agent[name] = { ...theirs, permission: layer(asMap(theirs.permission), ours) }
  }

  // Global: every other agent (build, plan, custom primaries) gets the default role's tools,
  // or none; nobody touches the store.
  const base = asMap(cfg.permission)
  const global = layer(
    base,
    defaultRole
      ? { ...rolePermission(config, defaultRole, mode), ...track }
      : { ...denyAll(mode), ...noTrack },
  )
  cfg.permission = { ...global, ...storeDenies(plan.storeDir, base) }

  // With a condenser configured Hafiz owns the tail and Kilo's own compaction would summarise it
  // away. Without one (llm.condenser.provider none) nothing trims the tail but the host, so its
  // compaction stays as the user set it.
  if (config.hafiz.llm.condenser.provider !== 'none' && !plan.untracked)
    cfg.compaction = { ...(cfg.compaction ?? {}), auto: false }

  // Slash commands.
  cfg.command ??= {}
  const cli = plan.hafiz.map(shellQuote).join(' ')
  cfg.command['hafiz-status'] ??= {
    description: 'Hafiz: project status (epoch, sessions, pending proposals)',
    template: `Hafiz project status:\n\n!\`${cli} status\`\n\nSummarise this for the user in a few lines. Do not call tools.`,
  }
  cfg.command['hafiz-checkpoint'] ??= {
    description: 'Hafiz: record unrecorded work and condense the conversation tail',
    // The shell line asks the daemon to condense this session at its next request.
    template:
      `!\`${cli} checkpoint\`\n\n` +
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
  return prompted
}
