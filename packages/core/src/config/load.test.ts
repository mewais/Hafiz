import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, mergeLayers } from './load.js'

describe('config', () => {
  it('loads and validates the built-in defaults', () => {
    const c = loadConfig()
    expect(Object.keys(c.roles.roles)).toEqual(['manager', 'designer', 'planner', 'worker'])
    expect(c.views.views.default?.rules?.length).toBeGreaterThan(5)
    expect(c.zooms.zooms.FULL).toBeDefined()
    expect(c.kinds.kinds.root?.schemas.design).toBe('root-design')
    expect(c.schemas['component-design']?.sections.some((s) => s.name === 'interface')).toBe(true)
    expect(c.rules['rules/worker.md']).toContain('worker')
  })

  it('merges override layers: objects deep, arrays replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hafiz-cfg-'))
    mkdirSync(join(dir, 'schemas'))
    writeFileSync(join(dir, 'hafiz.yaml'), 'confirm_done: ask\ntokenizer: { soft_zone: 0.2 }\n')
    writeFileSync(
      join(dir, 'roles.yaml'),
      'roles:\n  reviewer: { view: default, tools: [context.*], rules: rules/reviewer.md }\n',
    )
    const c = loadConfig([dir])
    expect(c.hafiz.confirm_done).toBe('ask')
    expect(c.hafiz.tokenizer.soft_zone).toBe(0.2)
    expect(c.hafiz.tokenizer.name).toBe('estimator') // untouched sibling key survives
    expect(c.roles.roles.reviewer?.tools).toEqual(['context.*'])
    expect(c.roles.roles.manager).toBeDefined() // existing roles kept
  })

  it('mergeLayers replaces arrays', () => {
    expect(mergeLayers({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } })).toEqual({
      a: [3],
      b: { c: 1, d: 2 },
    })
  })
})
