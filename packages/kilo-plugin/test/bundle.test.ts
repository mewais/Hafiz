import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const entry = join(root, 'packages/kilo-plugin/dist/index.js')

beforeAll(() => {
  execFileSync(process.execPath, [join(root, 'scripts/bundle.mjs'), 'kilo-plugin'], {
    stdio: 'pipe',
  })
}, 60_000)

describe('published bundle: hafiz-kilo', () => {
  it('is self-contained and default-exports { id, server } as Kilo (Bun) requires', async () => {
    const specifiers = [
      ...readFileSync(entry, 'utf8').matchAll(/^import .*? from "([^"]+)"/gm),
    ].map((m) => m[1])
    expect(specifiers.filter((s) => !s?.startsWith('node:'))).toEqual([])
    const mod = (await import(pathToFileURL(entry).href)) as {
      default: { id: string; server: unknown }
    }
    expect(mod.default.id).toBe('hafiz')
    expect(typeof mod.default.server).toBe('function')
    expect(Object.keys(mod.default).sort()).toEqual(['id', 'server'])
  })
})

describe('published bundle: hafiz-kilo/tui', () => {
  const tui = join(root, 'packages/kilo-plugin/dist/tui.js')
  it('is compiled Solid (universal, @opentui/solid) importing only what Kilo provides', () => {
    const code = readFileSync(tui, 'utf8')
    const specifiers = new Set(
      [...code.matchAll(/^import .*? from "([^"]+)"/gm)].map((m) => m[1] as string),
    )
    // Kilo's runtime maps these onto its own solid/opentui instances; everything else is inlined
    expect([...specifiers].filter((s) => !s.startsWith('node:')).sort()).toEqual([
      '@opentui/solid',
      'solid-js',
    ])
    expect(code).toMatch(/_\$createElement\("box"\)/) // JSX compiled away, universal renderer
    expect(code).not.toMatch(/<box[\s>]/)
    expect(code).toMatch(/export \{\s*plugin_default as default\s*\};?\s*$/) // default only
    expect(code).toContain('id: "hafiz"')
  })

  it('package exports: server entry (main, ./server) and the TUI entry (./tui)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/kilo-plugin/package.json'), 'utf8'))
    expect(pkg.main).toBe('./dist/index.js')
    expect(pkg.exports['./server'].import).toBe('./dist/index.js')
    expect(pkg.exports['./tui'].import).toBe('./dist/tui.js')
    // the server bundle stays free of the TUI runtime
    expect(readFileSync(entry, 'utf8')).not.toContain('@opentui/solid')
  })
})
