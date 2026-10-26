// Task definitions (`tasks/*.yaml`): setup, the user turns sent to Kilo, expectations, and the
// scripted model replies used in --mock mode.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'

const toolCall = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Save the `id` of this call's result as `{b.<as>}` for later steps. */
  as: z.string().optional(),
})

/** One scripted model reply: tool calls, text, or both. */
const step = z.object({
  calls: z.array(toolCall).optional(),
  text: z.string().optional(),
})

export interface SeedNode {
  /** Name for `{b.<as>}` in mock scripts. */
  as?: string | undefined
  title: string
  kind?: string | undefined
  status?: 'planned' | 'active' | 'done' | undefined
  /** One line; becomes a valid design doc. */
  purpose?: string | undefined
  /** Plan step titles; become a valid plan doc. */
  steps?: string[] | undefined
  decisions?:
    | Array<{
        title: string
        decision: string
        standing?: 'never' | 'always' | 'prefer' | undefined
      }>
    | undefined
  children?: SeedNode[] | undefined
}
const seedNode: z.ZodType<SeedNode> = z.lazy(() =>
  z.object({
    as: z.string().optional(),
    title: z.string(),
    kind: z.string().optional(),
    status: z.enum(['planned', 'active', 'done']).optional(),
    purpose: z.string().optional(),
    steps: z.array(z.string()).optional(),
    decisions: z
      .array(
        z.object({
          title: z.string(),
          decision: z.string(),
          standing: z.enum(['never', 'always', 'prefer']).optional(),
        }),
      )
      .optional(),
    children: z.array(seedNode).optional(),
  }),
)

export const taskSchema = z.object({
  id: z.string(),
  size: z.enum(['S', 'M', 'L']),
  description: z.string(),
  /** Kilo agent for every turn unless a turn names its own. */
  agent: z.string().default('build'),
  setup: z
    .object({
      project_name: z.string().default('Toy Shop'),
      /**
       * Run `hafiz init` (and the seed) before Kilo starts: the repo is already a tracked project.
       * Default false: the repo is untracked and the manager starts tracking with
       * `hafiz_track_project` when work turns multi-step, as a real user's agent would.
       */
      tracked: z.boolean().default(false),
      /** Blocks created under the root (and their children) before the first turn. */
      seed: z.array(seedNode).default([]),
    })
    .default({ project_name: 'Toy Shop', tracked: false, seed: [] }),
  /**
   * Overrides for the run's `policies.yaml` (written to `$HAFIZ_HOME/config/policies.yaml` before
   * Kilo starts), e.g. `review: { design: gate, plan: gate }`.
   */
  policies: z.record(z.string(), z.unknown()).optional(),
  /** Per-turn wall-clock limit in seconds for this task; overrides `--turn-timeout`. */
  turn_timeout: z.number().positive().optional(),
  turns: z
    .array(
      z.object({
        prompt: z.string(),
        agent: z.string().optional(),
        /**
         * After the turn, resolve every pending review proposal as the `user` role (through the
         * daemon) before the next turn: accept or reject (with `note`); default `none`.
         */
        review: z.enum(['accept', 'reject', 'none']).default('none'),
        note: z.string().optional(),
      }),
    )
    .min(1),
  /** metric -> ">=1" | "==3" | "1..3" | 3. See score.ts for the metric names. */
  expect: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  /** Mock mode only: the model's replies per turn and role. */
  mock: z
    .array(z.object({ turn: z.number().int().min(1), roles: z.record(z.string(), z.array(step)) }))
    .default([]),
})

export type Task = z.infer<typeof taskSchema>
export type MockStep = z.infer<typeof step>
export type MockToolCall = z.infer<typeof toolCall>

export function parseTask(source: string, origin = 'task'): Task {
  const r = taskSchema.safeParse(parse(source, { merge: true }))
  if (!r.success)
    throw new Error(
      `${origin}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  return r.data
}

/** The tasks shipped with the package (`packages/harness/tasks`). */
export const DEFAULT_TASKS_DIR = fileURLToPath(new URL('../tasks', import.meta.url))

/** Load tasks from files and directories (a directory contributes its *.yaml, sorted). */
export function loadTasks(paths: readonly string[] = [DEFAULT_TASKS_DIR], only?: string[]): Task[] {
  const files: string[] = []
  for (const p of paths) {
    const full = resolve(p)
    if (!existsSync(full)) throw new Error(`tasks path not found: ${p}`)
    if (statSync(full).isDirectory())
      files.push(
        ...readdirSync(full)
          .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
          .sort()
          .map((f) => join(full, f)),
      )
    else files.push(full)
  }
  const tasks = files.map((f) => parseTask(readFileSync(f, 'utf8'), f))
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id '${t.id}'`)
    ids.add(t.id)
  }
  const picked = only?.length
    ? tasks.filter((t) => only.includes(t.id) || only.includes(t.size))
    : tasks
  if (only?.length && !picked.length) throw new Error(`no task matches ${only.join(',')}`)
  return picked
}
