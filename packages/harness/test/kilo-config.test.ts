// --isolate keeps only the owner's providers and model keys from their Kilo config.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { keptKiloConfig, parseJsonc, writeIsolatedKiloConfig } from '../src/kilo-config.js'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'hafiz-kcfg-')))

describe('isolated Kilo config', () => {
  it('reads JSONC: comments, trailing commas, slashes inside strings', () => {
    expect(parseJsonc('{\n // c\n "a": "http://x/*y*/", /* b */ "b": [1, 2,],\n}')).toEqual({
      a: 'http://x/*y*/',
      b: [1, 2],
    })
  })

  it('keeps provider, model and small_model from every config file, later files winning', () => {
    const xdg = tmp()
    const dir = join(xdg, 'kilo')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'opencode.json'),
      JSON.stringify({ provider: { a: { options: { baseURL: 'u1' } } }, agent: { coder1: {} } }),
    )
    writeFileSync(
      join(dir, 'kilo.jsonc'),
      '{ // mine\n "model": "a/m", "small_model": "a/s",\n "provider": { "a": { "options": { "apiKey": "{env:A_KEY}" } } },\n "plugin": ["x"], }',
    )
    expect(keptKiloConfig(dir)).toEqual({
      provider: { a: { options: { baseURL: 'u1', apiKey: '{env:A_KEY}' } } },
      model: 'a/m',
      small_model: 'a/s',
    })
    const out = tmp()
    writeIsolatedKiloConfig({ XDG_CONFIG_HOME: xdg }, out)
    const written = JSON.parse(readFileSync(join(out, 'kilo', 'kilo.json'), 'utf8'))
    expect(Object.keys(written).sort()).toEqual(['model', 'provider', 'small_model'])
    expect(JSON.stringify(written)).toContain('{env:A_KEY}') // never resolved into the file
  })

  it('no owner config: nothing kept, no file', () => {
    const out = tmp()
    expect(writeIsolatedKiloConfig({ HOME: tmp() }, out)).toEqual({})
  })
})
