import { z } from 'zod'
import { ExprError, parseExpr } from '../session/expr.js'

// Zod schemas for every configuration file. The YAML in config/default is the reference.

const sectionFormat = z.enum(['prose', 'list', 'structured', 'steps', 'refs'])

export const docSchemaFile = z.object({
  type: z.enum(['design', 'plan', 'digest']),
  sections: z.array(
    z.object({
      name: z.string(),
      required: z.boolean().default(false),
      cap: z.number().int().positive(),
      format: sectionFormat,
    }),
  ),
})
export type DocSchema = z.infer<typeof docSchemaFile>

export const logsSchemaFile = z.object({
  progress: z.object({
    fields: z.array(z.string()),
    kinds: z.array(z.string()),
    cap: z.number().int().positive(),
  }),
  decision: z.object({
    fields: z.array(z.string()),
    standing: z.array(z.string()),
    cap: z.number().int().positive(),
    standing_cap: z.number().int().positive(),
  }),
  thread: z.object({
    fields: z.array(z.string()),
    gist_cap: z.number().int().positive(),
    entry_cap: z.number().int().positive(),
  }),
  step: z.object({ fields: z.array(z.string()), statuses: z.array(z.string()) }),
})

// none | fake | openai-compatible | anthropic. `api_key_env` names the variable holding the key.
const llmSettings = z.object({
  provider: z.string(),
  model: z.string(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  max_tokens: z.number().int().positive().optional(),
  timeout_seconds: z.number().positive().optional(),
})

export const hafizFile = z.object({
  storage: z.object({
    backend: z.string().default('fs'),
    root: z.string().default('~/.hafiz/projects'),
    git: z
      .object({
        enabled: z.boolean().default(true),
        minor_write_batch_seconds: z.number().default(30),
      })
      .prefault({}),
  }),
  schema_set: z.string().default('default'),
  // Version of the schema set; projects pin it and `hafiz migrate` upgrades them (migrations/).
  schema_version: z.coerce.string().default('1'),
  tokenizer: z.object({
    name: z.string().default('estimator'),
    soft_zone: z.number().min(0).max(1).default(0.15),
  }),
  windows: z.record(z.string(), z.number().int().positive()).default({ default: 200000 }),
  llm: z
    .object({
      condenser: llmSettings,
      drafters: llmSettings.extend({ enabled: z.boolean().default(false) }),
    })
    .default({
      condenser: { provider: 'none', model: 'cheap' },
      drafters: { enabled: false, provider: 'none', model: 'cheap' },
    }),
  daemon: z.object({ idle_shutdown_seconds: z.number().default(900) }).prefault({}),
  onboarding: z
    .object({
      // A repo with commits and at least this many tracked source files is brownfield.
      min_source_files: z.number().int().nonnegative().default(5),
      // Shown at the top of these roles' views once tracked work has started on a project whose onboarding is pending.
      directive: z.string().default(''),
      roles: z.array(z.string()).default(['manager']),
    })
    .prefault({}),
  host: z
    .object({
      kilo: z
        .object({
          // proxy = embedded-proxy, hooks = experimental transform hooks, auto = hooks if present
          shaper: z.enum(['proxy', 'hooks', 'auto']).default('auto'),
          // native = Hafiz tools registered through the plugin `tool` hook (they see the
          // calling Kilo session); mcp = one `hafiz-<role>` MCP server per role (legacy).
          tools: z.enum(['native', 'mcp']).default('native'),
          // Role for Kilo primary agents that are not Hafiz roles (build, plan, …); none = off.
          default_role: z.string().default('manager'),
          // Role for non-Hafiz subagents (general, explore, …) spawned on a
          // block (the `block` argument of Kilo's `task`); otherwise they stay unmanaged. none = off.
          default_subagent_role: z.string().default('worker'),
          // A managed `task` prompt longer than this (tokens) is refused: the subagent already
          // sees its block, so the prompt carries only the wishes and scope on top.
          delegation_prompt_cap: z.number().int().positive().default(600),
        })
        .prefault({}),
    })
    .prefault({}),
})

const docTypeName = z.enum(['design', 'plan', 'digest'])
const migrationStep = z.union([
  z.object({ rename_section: z.object({ schema: z.string(), from: z.string(), to: z.string() }) }),
  z.object({ add_section: z.object({ schema: z.string(), name: z.string(), default: z.any() }) }),
  z.object({ drop_section: z.object({ schema: z.string(), name: z.string() }) }),
  // Blocks of `kind` switch the `type` doc from schema `from` to schema `to`.
  z.object({
    map_kind: z.object({ kind: z.string(), type: docTypeName, from: z.string(), to: z.string() }),
  }),
])
export type MigrationStep = z.infer<typeof migrationStep>

/** `migrations/<from>-<to>.yaml` in a schema set. */
export const migrationFile = z.object({
  from: z.coerce.string(),
  to: z.coerce.string(),
  description: z.string().optional(),
  steps: z.array(migrationStep),
})
export type Migration = z.infer<typeof migrationFile>

export const kindsFile = z.object({
  kinds: z.record(
    z.string(),
    z.object({
      schemas: z.record(z.string(), z.string()),
      no_children: z.boolean().optional(),
    }),
  ),
  default_kind: z.string(),
})

const zoomName = z.string()
// Every key is an attribute Relate computes (relation, status, kind, depth, dep_distance, …);
// new attributes need no schema change. A list value means any-of.
const matchScalar = z.union([z.string(), z.number(), z.boolean()])
const matchClause = z.record(z.string(), z.union([matchScalar, z.array(matchScalar)]))
export type MatchClause = z.infer<typeof matchClause>

export const zoomsFile = z.object({
  zooms: z.record(zoomName, z.array(z.string())),
  floor: z.array(
    z.object({ match: matchClause, sections: z.array(z.string()), cap: z.number().int() }),
  ),
})

const viewRule = z.union([
  z.object({ match: matchClause, zoom: zoomName, floor: zoomName.optional() }),
  z.object({ default: zoomName }),
])
const degradeStep = z.object({
  match: matchClause,
  to: zoomName.optional(),
  trim: z.record(z.string(), z.number().int()).optional(),
  order: z.enum(['focus_reverse']).optional(),
})
const viewDef = z.object({
  extends: z.string().optional(),
  budget: z
    .object({
      share_of_window: z.number().optional(),
      min_tokens: z.number().int().optional(),
      max_tokens: z.number().int().optional(),
    })
    .optional(),
  dependency_depth: z.number().int().optional(),
  rules: z.array(viewRule).optional(),
  rules_prepend: z.array(viewRule).optional(),
  degrade: z.array(degradeStep).optional(),
})
export type ViewRule = z.infer<typeof viewRule>
export type DegradeStep = z.infer<typeof degradeStep>
export type ViewDef = z.infer<typeof viewDef>
export const viewsFile = z.object({ views: z.record(z.string(), viewDef) })

export const rolesFile = z.object({
  roles: z.record(
    z.string(),
    z.object({
      view: z.string(),
      focus_policy: z.enum(['all_active', 'spawned_block', 'none']).default('none'),
      tools: z.array(z.string()),
      rules: z.string(),
      /** False for roles a person plays (the CLI user, the TUI viewer): hosts register no agent. */
      agent: z.boolean().default(true),
      /** The daemon refuses every write for sessions of this role, whatever `tools` says. */
      read_only: z.boolean().default(false),
    }),
  ),
})
export type RoleDef = z.infer<typeof rolesFile>['roles'][string]

/** Sessions of read_only roles (the TUI viewer) watch the project; they are not agents. */
export function isViewerSession(roles: z.infer<typeof rolesFile>, s: { role: string }): boolean {
  return !!roles.roles[s.role]?.read_only
}

/**
 * A block's state for spawning: `done` and `dropped` by status, otherwise by its docs
 * (`no_design`, `no_plan`, `has_plan`).
 */
export const SPAWN_STATES = ['no_design', 'no_plan', 'has_plan', 'done', 'dropped'] as const
export type SpawnState = (typeof SPAWN_STATES)[number]

const reviewMode = z.enum(['off', 'queue', 'gate'])

/**
 * `policies.yaml review`: per event, whether a proposal is filed (`queue`) and whether it holds
 * the next stage on that block until accepted (`gate`). `approver` may resolve review proposals.
 */
export const reviewPolicy = z
  .object({
    design: reviewMode.default('queue'),
    plan: reviewMode.default('queue'),
    done: reviewMode.default('gate'),
    // Condenser and drafter proposals: suggestions about what was not recorded, never a hold.
    drafts: reviewMode.default('queue').refine((m) => m !== 'gate', {
      message: 'review.drafts cannot be gate: drafts never hold work (off | queue)',
    }),
    approver: z.enum(['user', 'manager']).default('user'),
  })
  .prefault({})
export type ReviewPolicy = z.infer<typeof reviewPolicy>

export const policiesFile = z.object({
  status: z.object({
    transitions: z.record(z.string(), z.array(z.string())),
    guards: z.record(z.string(), z.array(z.string())),
    activate_parent_on_child_active: z.boolean().default(true),
  }),
  epoch: z.object({ minor_paths: z.array(z.string()) }),
  caps: z.object({
    on_exceeded: z.enum(['reject', 'warn']).default('reject'),
    allow_block_overrides: z.boolean().default(true),
  }),
  // Roles a subagent may be spawned as on a block, by the block's state; `*` = any role.
  spawn: z.object({ roles_by_state: z.record(z.enum(SPAWN_STATES), z.array(z.string())) }),
  review: reviewPolicy,
})

export const complianceFile = z.object({
  checks: z.array(
    z.object({
      id: z.string(),
      when: z.enum(['session_end', 'counters', 'request_done']),
      cond: z.string().superRefine((src, ctx) => {
        try {
          parseExpr(src)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: e instanceof ExprError ? e.message : String(e) })
        }
      }),
      action: z.array(z.enum(['notice', 'proposal'])),
      /** Notice text; `{metric}` placeholders. */
      message: z.string().optional(),
    }),
  ),
  report_capture: z.object({ enabled: z.boolean(), cap_tokens: z.number().int() }),
})

export const nudgeFile = z.object({
  thresholds: z.record(z.string(), z.number()),
  max_per_session: z.number().int().default(1),
  template: z.string(),
  auto_init: z.boolean().default(false),
})

export const tailFile = z.object({
  tail: z.object({
    budget_share_of_window: z.number(),
    tool_result_max_age_turns: z.number().int(),
    stub_template: z.string(),
    never_stub: z.array(z.string()),
  }),
  delta: z.object({ cap_tokens: z.number().int() }),
  unfiled: z.object({ cap_tokens: z.number().int() }),
  condensation: z.object({ trigger: z.string(), slice_min_turns: z.number().int() }),
})

export const configSchema = z.object({
  hafiz: hafizFile,
  kinds: kindsFile,
  zooms: zoomsFile,
  views: viewsFile,
  roles: rolesFile,
  policies: policiesFile,
  compliance: complianceFile,
  nudge: nudgeFile,
  tail: tailFile,
  schemas: z.record(z.string(), docSchemaFile),
  migrations: z.record(z.string(), migrationFile).default({}),
  logs: logsSchemaFile,
  rules: z.record(z.string(), z.string()),
  /** Retired settings found in override layers and what they were mapped to (`hafiz doctor`). */
  deprecations: z.array(z.string()).default([]),
})
export type Config = z.infer<typeof configSchema>
