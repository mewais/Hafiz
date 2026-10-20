// The `config` hook's job: register role MCP servers, role agents, slash commands, store deny
// rules and compaction settings, and (proxy shaper) re-point provider base URLs. Pure apart from
// the `wrap` callback; user-provided entries win over ours.
import type { Config } from '@hafiz/core'
import type { KiloConfig } from './kilo.js'

export interface InstallPlan {
  config: Config
  repoRoot: string
  storeDir: string
  /** argv prefix that runs the `hafiz` CLI (e.g. [node, /path/bin.js]). */
  hafiz: string[]
  /** Extra environment for the MCP server processes. */
  env?: Record<string, string>
  /** Proxy: returns the base URL to use instead of `baseURL` for provider `id`. */
  wrap?: (id: string, baseURL: string) => string
}

const ROLE_DESCRIPTIONS: Record<string, string> = {
  manager: 'Hafiz manager: runs the block tree, delegates designer/planner/worker subagents',
  designer: 'Hafiz designer: writes and revises block designs',
  planner: 'Hafiz planner: breaks designed blocks into plans and child blocks',
  worker: 'Hafiz worker: implements one block; spawn with hafiz:block=<id> in the prompt',
}

/** Roles that get an MCP server and an agent (the `user` role is the human's CLI). */
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

export function installConfig(cfg: KiloConfig, plan: InstallPlan): void {
  const { config } = plan
  const roles = agentRoles(config)

  // MCP: one server per role. Kilo names their tools `hafiz-<role>_hafiz_<command>`.
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

  // Agents. Denying other role servers uses the unprefixed glob `hafiz-*`: Kilo copies a
  // parent agent's server-prefixed denies (`hafiz-worker_*`) into every subagent it spawns,
  // which would strip a worker's own tools.
  cfg.agent ??= {}
  for (const role of roles) {
    const def = config.roles.roles[role]
    const ours: Record<string, unknown> = {
      description: ROLE_DESCRIPTIONS[role] ?? `Hafiz ${role}`,
      mode: role === 'manager' ? 'primary' : 'subagent',
      prompt: (def && config.rules[def.rules]) ?? '',
      permission: {
        'hafiz-*': 'deny',
        [`hafiz-${role}_*`]: 'allow',
        task: role === 'manager' ? 'allow' : 'deny',
        ...storeDenies(plan.storeDir),
      },
    }
    const theirs = cfg.agent[role] ?? {}
    cfg.agent[role] = {
      ...ours,
      ...theirs,
      permission: {
        ...(ours.permission as Record<string, unknown>),
        ...((theirs.permission as Record<string, unknown> | undefined) ?? {}),
      },
    }
  }

  // Global: non-Hafiz agents (build, plan, …) see no role server; nobody touches the store.
  const perm = cfg.permission
  const base = typeof perm === 'string' ? { '*': perm } : { ...(perm ?? {}) }
  cfg.permission = { 'hafiz-*': 'deny', ...base, ...storeDenies(plan.storeDir, base) }

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
