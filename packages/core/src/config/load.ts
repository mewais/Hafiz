import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { type Config, configSchema } from './schema.js'

/**
 * Directory holding the built-in defaults, shipped with the core package. In the published
 * bundles (`hafiz-context-manager`, `hafiz-kilo`) the defaults are copied to `config/default` next to the
 * bundled entry file.
 */
export function defaultConfigDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  // src/config/load.ts -> ../../config/default ; dist/config/load.js -> ../../config/default
  const inPackage = resolve(here, '..', '..', 'config', 'default')
  return existsSync(inPackage) ? inPackage : resolve(here, 'config', 'default')
}

const FILES = [
  'hafiz',
  'kinds',
  'zooms',
  'views',
  'roles',
  'policies',
  'compliance',
  'nudge',
  'tail',
] as const

type RawLayer = Record<string, unknown>

function readYaml(path: string): unknown {
  return parse(readFileSync(path, 'utf8'))
}

/** Read one configuration directory into a raw (unvalidated) object. Missing files are skipped. */
export function readLayer(dir: string): RawLayer {
  const out: RawLayer = {}
  for (const name of FILES) {
    const p = join(dir, `${name}.yaml`)
    if (existsSync(p)) out[name] = readYaml(p)
  }
  const schemasDir = join(dir, 'schemas')
  if (existsSync(schemasDir)) {
    const schemas: Record<string, unknown> = {}
    for (const f of readdirSync(schemasDir)) {
      if (!f.endsWith('.yaml')) continue
      const key = f.slice(0, -5)
      if (key === 'logs') out.logs = readYaml(join(schemasDir, f))
      else schemas[key] = readYaml(join(schemasDir, f))
    }
    out.schemas = schemas
  }
  const migrationsDir = join(dir, 'migrations')
  if (existsSync(migrationsDir)) {
    const migrations: Record<string, unknown> = {}
    for (const f of readdirSync(migrationsDir))
      if (f.endsWith('.yaml')) migrations[f.slice(0, -5)] = readYaml(join(migrationsDir, f))
    out.migrations = migrations
  }
  const rulesDir = join(dir, 'rules')
  if (existsSync(rulesDir)) {
    const rules: Record<string, string> = {}
    for (const f of readdirSync(rulesDir)) {
      if (f.endsWith('.md')) rules[`rules/${f}`] = readFileSync(join(rulesDir, f), 'utf8')
    }
    out.rules = rules
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Deep merge: objects merge key-wise, arrays and scalars are replaced by the later layer. */
export function mergeLayers(base: RawLayer, over: RawLayer): RawLayer {
  const out: RawLayer = { ...base }
  for (const [k, v] of Object.entries(over)) {
    const b = out[k]
    out[k] = isPlainObject(b) && isPlainObject(v) ? mergeLayers(b, v) : v
  }
  return out
}

/** `confirm_done` (hafiz.yaml) before `policies.yaml review.done`: ask held the block, auto did not. */
const CONFIRM_DONE: Record<string, string> = { ask: 'gate', auto: 'queue' }

/**
 * Map settings an override layer may still carry from earlier versions onto their successors,
 * in place, and say what was mapped (`hafiz doctor` shows it). A layer that also sets the
 * successor keeps its own value.
 */
export function migrateLayer(layer: RawLayer, where: string): string[] {
  const notes: string[] = []
  const hafiz = layer.hafiz
  if (isPlainObject(hafiz) && 'confirm_done' in hafiz) {
    const old = String(hafiz.confirm_done)
    delete hafiz.confirm_done
    const mode = CONFIRM_DONE[old]
    if (!mode)
      throw new Error(
        `${where}/hafiz.yaml: confirm_done is retired; set policies.yaml review.done (off | queue | gate)`,
      )
    const policies = isPlainObject(layer.policies) ? layer.policies : {}
    const review = isPlainObject(policies.review) ? policies.review : {}
    if (review.done === undefined) review.done = mode
    layer.policies = { ...policies, review }
    notes.push(
      `${where}/hafiz.yaml: confirm_done: ${old} is retired; read as policies.yaml review.done: ${String(review.done)}. Move it there.`,
    )
  }
  const guards = isPlainObject(layer.policies) ? layer.policies.status : undefined
  const lists = isPlainObject(guards) && isPlainObject(guards.guards) ? guards.guards : {}
  for (const [k, v] of Object.entries(lists))
    if (Array.isArray(v) && v.includes('confirm_done')) {
      lists[k] = v.map((g) => (g === 'confirm_done' ? 'review_done' : g))
      notes.push(
        `${where}/policies.yaml: guard confirm_done is now review_done (status.guards.${k}).`,
      )
    }
  return notes
}

/**
 * Load configuration from the built-in defaults plus any number of override directories
 * (user, then project). Later directories win.
 */
export function loadConfig(overrideDirs: string[] = []): Config {
  let raw = readLayer(defaultConfigDir())
  const deprecations: string[] = []
  for (const d of overrideDirs) {
    if (!existsSync(d)) continue
    const layer = readLayer(d)
    deprecations.push(...migrateLayer(layer, d))
    raw = mergeLayers(raw, layer)
  }
  return configSchema.parse({ ...raw, deprecations })
}

/** The user-level override layer, `~/.hafiz/config` (`$HAFIZ_HOME/config`). */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HAFIZ_HOME || join(homedir(), '.hafiz'), 'config')
}

/** Override layers for a project: user-level `~/.hafiz/config`, then `<store>/config`. */
export function configDirs(storeDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return [userConfigDir(env), join(storeDir, 'config')]
}

/** Rules shared by every agent role; prepended to the role's own file. */
export const COMMON_RULES = 'rules/common.md'

/**
 * Roles hosts install as agents: every role except the ones a person plays (`agent: false` in
 * roles.yaml: the CLI `user`, the TUI `viewer`).
 */
export function agentRoleNames(config: Config): string[] {
  return Object.entries(config.roles.roles)
    .filter(([name, def]) => name !== 'user' && def.agent !== false)
    .map(([name]) => name)
}

/**
 * The prompt text for a role: the role's `rules` file followed by `rules/common.md` (if
 * present). Roles a person plays (`user`, `viewer`) get only their own file.
 */
export function rulesFor(config: Config, role: string): string {
  const def = config.roles.roles[role]
  if (!def) return ''
  const own = (config.rules[def.rules] ?? '').trim()
  const person = role === 'user' || def.agent === false
  const common = person ? '' : (config.rules[COMMON_RULES] ?? '').trim()
  return [own, common].filter(Boolean).join('\n\n')
}
