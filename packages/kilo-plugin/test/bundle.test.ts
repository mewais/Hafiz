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

describe('published bundle: @hafiz/kilo-plugin', () => {
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
