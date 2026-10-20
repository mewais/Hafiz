// Schema-set versioning (ARCHITECTURE §4). Migrations are declarative YAML in the schema set
// (`migrations/<from>-<to>.yaml`); planning is pure, applying goes through Core as the user.
import type { Config, Migration } from '../config/schema.js'
import type { Block, Doc, DocType, Project, SectionValue } from '../domain/types.js'
import type { Tokenizer } from '../tokenizer.js'
import { schemaFor, validateDoc } from './validate.js'

/** Stores created before versioning pinned the schema set *name* ('default'): that is version 1. */
export function normalizeSchemaVersion(v: string | undefined): string {
  return v && /^\d+$/.test(v) ? v : '1'
}

export interface DocChange {
  block: string
  type: DocType
  actions: string[]
  before: Record<string, SectionValue>
  after: Record<string, SectionValue>
}

export interface MigrationPlan {
  from: string
  to: string
  files: string[]
  changes: DocChange[]
  /** Docs the migrated sections still do not satisfy; the migration refuses to run while any exist. */
  failures: Array<{ block: string; type: DocType; error: string }>
  /** Set when the pinned version cannot reach the schema set's version. */
  error?: string
}

/** The chain of migrations from `from` up to the loaded schema set's version. */
export function migrationPath(
  config: Config,
  from: string,
): { path: Array<[string, Migration]>; error?: string } {
  const target = config.hafiz.schema_version
  const path: Array<[string, Migration]> = []
  let cur = from
  while (cur !== target) {
    const next = Object.entries(config.migrations).find(([, m]) => m.from === cur)
    if (!next || path.some(([, m]) => m.to === next[1].to))
      return {
        path,
        error: `no migration from schema version ${cur} towards ${target} (expected migrations/${cur}-<to>.yaml)`,
      }
    path.push(next)
    cur = next[1].to
  }
  return { path }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function planMigration(
  config: Config,
  tok: Tokenizer,
  project: Project,
  blocks: readonly Block[],
  docs: readonly Doc[],
): MigrationPlan {
  const from = normalizeSchemaVersion(project.schemaSetVersion)
  const to = config.hafiz.schema_version
  const plan: MigrationPlan = { from, to, files: [], changes: [], failures: [] }
  if (from === to) return plan
  const { path, error } = migrationPath(config, from)
  if (error) return { ...plan, error }
  plan.files = path.map(([name]) => `migrations/${name}.yaml`)

  // Schema each (kind, type) used before the migration: the first map_kind's `from`, else today's.
  const initial = new Map<string, string>()
  for (const [, m] of path)
    for (const s of m.steps)
      if ('map_kind' in s) {
        const k = `${s.map_kind.kind}/${s.map_kind.type}`
        if (!initial.has(k)) initial.set(k, s.map_kind.from)
      }
  const kindOf = new Map(blocks.map((b) => [b.id, b.kind]))

  for (const doc of docs) {
    const kind = kindOf.get(doc.blockId)
    if (!kind) continue
    const key = `${kind}/${doc.type}`
    let schema: string | undefined = initial.get(key)
    schema ??=
      config.kinds.kinds[kind]?.schemas[doc.type] ??
      config.kinds.kinds[config.kinds.default_kind]?.schemas[doc.type]
    let sections = structuredClone(doc.sections)
    const actions: string[] = []
    for (const [, m] of path)
      for (const s of m.steps) {
        if ('map_kind' in s) {
          const mk = s.map_kind
          if (mk.kind === kind && mk.type === doc.type && schema === mk.from) {
            schema = mk.to
            actions.push(`schema ${mk.from} → ${mk.to}`)
          }
        } else if ('rename_section' in s) {
          const r = s.rename_section
          if (r.schema === schema && r.from in sections) {
            const out: Record<string, SectionValue> = {}
            for (const [k, v] of Object.entries(sections)) out[k === r.from ? r.to : k] = v
            sections = out
            actions.push(`rename ${r.from} → ${r.to}`)
          }
        } else if ('add_section' in s) {
          const a = s.add_section
          if (a.schema === schema && !(a.name in sections)) {
            sections[a.name] = structuredClone(a.default) as SectionValue
            actions.push(`add ${a.name}`)
          }
        } else if ('drop_section' in s) {
          const d = s.drop_section
          if (d.schema === schema && d.name in sections) {
            delete sections[d.name]
            actions.push(`drop ${d.name}`)
          }
        }
      }
    if (same(sections, doc.sections)) continue
    try {
      validateDoc(config, tok, schemaFor(config, kind, doc.type), sections)
    } catch (e) {
      plan.failures.push({
        block: doc.blockId,
        type: doc.type,
        error: e instanceof Error ? e.message : String(e),
      })
      continue
    }
    plan.changes.push({
      block: doc.blockId,
      type: doc.type,
      actions,
      before: doc.sections,
      after: sections,
    })
  }
  return plan
}

export interface DocProblem {
  block: string
  type: DocType
  problem: string
}

/** Docs that do not satisfy the loaded schema set (strict check; reads stay lenient). */
export function checkDocs(
  config: Config,
  tok: Tokenizer,
  blocks: readonly Block[],
  docs: readonly Doc[],
): DocProblem[] {
  const kindOf = new Map(blocks.map((b) => [b.id, b.kind]))
  const out: DocProblem[] = []
  for (const d of docs) {
    const kind = kindOf.get(d.blockId)
    if (!kind) continue
    try {
      validateDoc(config, tok, schemaFor(config, kind, d.type), d.sections)
    } catch (e) {
      out.push({
        block: d.blockId,
        type: d.type,
        problem: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out
}
