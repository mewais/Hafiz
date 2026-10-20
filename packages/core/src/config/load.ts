import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { type Config, configSchema } from './schema.js'

/** Directory holding the built-in defaults, shipped with the core package. */
export function defaultConfigDir(): string {
  // src/config/load.ts → ../../config/default ; dist/config/load.js → ../../config/default
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'default')
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

/**
 * Load configuration from the built-in defaults plus any number of override directories
 * (user, then project). Later directories win.
 */
export function loadConfig(overrideDirs: string[] = []): Config {
  let raw = readLayer(defaultConfigDir())
  for (const d of overrideDirs) if (existsSync(d)) raw = mergeLayers(raw, readLayer(d))
  return configSchema.parse(raw)
}

/** Rules shared by every agent role; prepended to the role's own file. */
export const COMMON_RULES = 'rules/common.md'

/**
 * The prompt text for a role: the role's `rules` file followed by `rules/common.md` (if
 * present). The `user` role is the human at the CLI and gets only its own file.
 */
export function rulesFor(config: Config, role: string): string {
  const def = config.roles.roles[role]
  if (!def) return ''
  const own = (config.rules[def.rules] ?? '').trim()
  const common = role === 'user' ? '' : (config.rules[COMMON_RULES] ?? '').trim()
  return [own, common].filter(Boolean).join('\n\n')
}
