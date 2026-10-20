// `hafiz install kilo [--global|--project]` / `hafiz uninstall kilo`: add or remove the Hafiz
// plugin in Kilo's `plugin` array. The config is JSONC; edits are surgical so comments, key order
// and formatting survive.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  applyEdits,
  type Edit,
  format,
  modify,
  type ParseError,
  parse,
  printParseErrorCode,
} from 'jsonc-parser'
import { CliError, repoRootOf } from './resolve.js'
import type { Io } from './shared.js'

export const KILO_PLUGIN = '@hafiz/kilo-plugin'
const FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' }

/** Candidate Kilo config files, most specific first. */
export function kiloConfigCandidates(io: Pick<Io, 'cwd' | 'env'>, global: boolean): string[] {
  if (global) {
    const base = io.env.XDG_CONFIG_HOME || join(io.env.HOME || homedir(), '.config')
    return ['kilo.jsonc', 'kilo.json'].map((f) => join(base, 'kilo', f))
  }
  let root = io.cwd
  try {
    root = repoRootOf(io.cwd)
  } catch {}
  return [
    join(root, 'kilo.jsonc'),
    join(root, 'kilo.json'),
    join(root, '.kilo', 'kilo.jsonc'),
    join(root, '.kilo', 'kilo.json'),
  ]
}

/** Apply edits, then format only the inserted text so the rest of the file stays as written. */
function formatEdits(text: string, edits: Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.offset - a.offset)) {
    out = applyEdits(out, [e])
    // Cover the rest of the touched line too: a removal can leave the closing bracket behind.
    const eol = out.indexOf('\n', e.offset + e.content.length)
    const length = (eol < 0 ? out.length : eol) - e.offset
    const fmt = format(out, { offset: e.offset, length }, FORMAT)
    out = applyEdits(out, fmt)
  }
  return out
}

const specifier = (entry: unknown): unknown => (Array.isArray(entry) ? entry[0] : entry)

function parseConfig(file: string, text: string): { plugin?: unknown } {
  const errors: ParseError[] = []
  const v = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first) throw new CliError(`${file} is not valid JSONC (${printParseErrorCode(first.error)})`)
  return (v ?? {}) as { plugin?: unknown }
}

/** Index of the Hafiz plugin in the `plugin` array of `text`, or -1. */
export function pluginIndex(file: string, text: string): number {
  const plugin = parseConfig(file, text).plugin
  return Array.isArray(plugin) ? plugin.findIndex((e) => specifier(e) === KILO_PLUGIN) : -1
}

/** Config files (project, then global) that list the Hafiz plugin. */
export function kiloInstalledIn(io: Pick<Io, 'cwd' | 'env'>): string[] {
  const out: string[] = []
  for (const global of [false, true])
    for (const file of kiloConfigCandidates(io, global))
      if (existsSync(file)) {
        try {
          if (pluginIndex(file, readFileSync(file, 'utf8')) >= 0) out.push(file)
        } catch {}
      }
  return out
}

/** Where Kilo's TUI reads plugins: `tui.json[c]` next to the server config (Kilo ≥ 7.8). */
export function kiloTuiCandidates(
  serverFile: string,
  io: Pick<Io, 'cwd' | 'env'>,
  global: boolean,
) {
  if (global) {
    const base = io.env.XDG_CONFIG_HOME || join(io.env.HOME || homedir(), '.config')
    return ['tui.jsonc', 'tui.json'].map((f) => join(base, 'kilo', f))
  }
  const dir = dirname(serverFile)
  const root = dirname(kiloConfigCandidates(io, false)[0] as string)
  const own = ['tui.jsonc', 'tui.json'].map((f) => join(dir, f))
  const others = [root, join(root, '.kilo')]
    .filter((d) => d !== dir)
    .flatMap((d) => ['tui.jsonc', 'tui.json'].map((f) => join(d, f)))
  return [...own, ...others]
}

type Outcome = 'added' | 'present' | 'removed' | 'absent'

/** Add or remove the Hafiz entry in the `plugin` array of the first fitting candidate file. */
function editPlugins(
  candidates: string[],
  action: 'install' | 'uninstall',
): { file: string; outcome: Outcome } {
  const holdsPlugin = (f: string) => existsSync(f) && pluginIndex(f, readFileSync(f, 'utf8')) >= 0
  const file =
    candidates.find(holdsPlugin) ??
    candidates.find((f) => existsSync(f)) ??
    (candidates[0] as string)
  const exists = existsSync(file)
  let text = exists ? readFileSync(file, 'utf8') : '{\n}\n'
  const idx = pluginIndex(file, text)
  if (action === 'install') {
    if (idx >= 0) return { file, outcome: 'present' }
    const plugin = parseConfig(file, text).plugin
    if (plugin !== undefined && !Array.isArray(plugin))
      throw new CliError(`${file}: "plugin" is not an array; add "${KILO_PLUGIN}" by hand`)
    const edits = Array.isArray(plugin)
      ? modify(text, ['plugin', -1], KILO_PLUGIN, { isArrayInsertion: true })
      : modify(text, ['plugin'], [KILO_PLUGIN], {})
    text = formatEdits(text, edits)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return { file, outcome: 'added' }
  }
  if (!exists || idx < 0) return { file, outcome: 'absent' }
  writeFileSync(file, formatEdits(text, modify(text, ['plugin', idx], undefined, {})))
  return { file, outcome: 'removed' }
}

/**
 * The server plugin goes in Kilo's `kilo.json[c]` `plugin` list, the TUI panel in `tui.json[c]`
 * (same npm package: Kilo loads its `./tui` export there). Both edits are idempotent.
 */
export async function installHost(
  io: Io,
  action: 'install' | 'uninstall',
  host: string,
  opts: { global: boolean },
): Promise<void> {
  if (host !== 'kilo')
    throw new CliError(`unknown host '${host}'; only 'kilo' is supported (HOST-MATRIX.md)`)
  const scope = opts.global ? 'global' : 'project'
  const server = editPlugins(kiloConfigCandidates(io, opts.global), action)
  const tui = editPlugins(kiloTuiCandidates(server.file, io, opts.global), action)
  const say = (r: { file: string; outcome: Outcome }, what: string) => {
    if (r.outcome === 'added') io.out(`installed ${KILO_PLUGIN} (${what}) in ${r.file} (${scope})`)
    if (r.outcome === 'present') io.out(`already installed (${what}) in ${r.file}`)
    if (r.outcome === 'removed')
      io.out(`removed ${KILO_PLUGIN} (${what}) from ${r.file} (${scope})`)
    if (r.outcome === 'absent') io.out(`not installed (${what}) in ${r.file}`)
  }
  say(server, 'server plugin')
  say(tui, 'TUI panel')
  if (server.outcome === 'added' || tui.outcome === 'added')
    io.out('restart Kilo to load it; `hafiz init <name>` enables it in a repo')
}
