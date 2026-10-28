// What `--isolate` keeps of the owner's own Kilo config: only where their models live. Kilo
// merges its global config from these files in $XDG_CONFIG_HOME/kilo (default ~/.config/kilo);
// the isolated run gets a private config dir holding just their `provider` section and the
// `model` / `small_model` keys, so custom providers keep working while their agents, plugins,
// permissions and instructions stay out. `{env:…}` references are copied as written (the run
// keeps the owner's environment), never resolved into the file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Kilo's global config files, in the order they are merged here (a later file wins). */
export const KILO_CONFIG_FILES = [
  'config.json',
  'opencode.json',
  'opencode.jsonc',
  'kilo.json',
  'kilo.jsonc',
] as const

/** The keys an isolated run keeps. */
export const KEPT_KEYS = ['provider', 'model', 'small_model'] as const

/** JSON with comments and trailing commas (Kilo's config syntax) → a value. */
export function parseJsonc(text: string): unknown {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function merge(a: unknown, b: unknown): unknown {
  if (!isObject(a) || !isObject(b)) return b
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v)
  return out
}

/** The owner's Kilo config dir: `$XDG_CONFIG_HOME/kilo`, else `~/.config/kilo`. */
export function kiloConfigDir(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'kilo')
}

/** `provider`, `model` and `small_model` from the owner's Kilo config files; {} if none. */
export function keptKiloConfig(dir: string): Record<string, unknown> {
  let kept: Record<string, unknown> = {}
  for (const name of KILO_CONFIG_FILES) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    let parsed: unknown
    try {
      parsed = parseJsonc(readFileSync(file, 'utf8'))
    } catch (e) {
      throw new Error(`--isolate: cannot read ${file}: ${e instanceof Error ? e.message : e}`)
    }
    if (!isObject(parsed)) continue
    const pick = Object.fromEntries(KEPT_KEYS.filter((k) => k in parsed).map((k) => [k, parsed[k]]))
    kept = merge(kept, pick) as Record<string, unknown>
  }
  return kept
}

/**
 * Make `xdgConfigHome` an isolated Kilo config home: `<xdgConfigHome>/kilo/kilo.json` holds only
 * the kept keys of the owner's config (read from `env` before it is redirected). Returns them.
 */
export function writeIsolatedKiloConfig(
  env: NodeJS.ProcessEnv,
  xdgConfigHome: string,
): Record<string, unknown> {
  const kept = keptKiloConfig(kiloConfigDir(env))
  const dir = join(xdgConfigHome, 'kilo')
  mkdirSync(dir, { recursive: true })
  if (Object.keys(kept).length)
    writeFileSync(join(dir, 'kilo.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
  return kept
}
