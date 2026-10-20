import { z } from 'zod'

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
  tokenizer: z.object({
    name: z.string().default('estimator'),
    soft_zone: z.number().min(0).max(1).default(0.15),
  }),
  windows: z.record(z.string(), z.number().int().positive()).default({ default: 200000 }),
  confirm_done: z.enum(['auto', 'ask']).default('auto'),
  llm: z
    .object({
      condenser: z.object({ provider: z.string(), model: z.string() }),
      drafters: z.object({ enabled: z.boolean(), provider: z.string(), model: z.string() }),
    })
    .default({
      condenser: { provider: 'none', model: 'cheap' },
      drafters: { enabled: false, provider: 'none', model: 'cheap' },
    }),
  daemon: z.object({ idle_shutdown_seconds: z.number().default(900) }).prefault({}),
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
          // Role for non-Hafiz subagents (general, explore, …) spawned with a
          // `hafiz:block=<id>` marker; without the marker they stay unmanaged. none = off.
          default_subagent_role: z.string().default('worker'),
        })
        .prefault({}),
    })
    .prefault({}),
})

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
    }),
  ),
})
export type RoleDef = z.infer<typeof rolesFile>['roles'][string]

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
})

export const complianceFile = z.object({
  checks: z.array(
    z.object({
      id: z.string(),
      when: z.enum(['session_end', 'counters', 'request_done']),
      cond: z.string(),
      action: z.array(z.enum(['notice', 'proposal'])),
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
  logs: logsSchemaFile,
  rules: z.record(z.string(), z.string()),
})
export type Config = z.infer<typeof configSchema>
