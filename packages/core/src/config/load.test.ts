import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig, mergeLayers } from './load.js'

describe('config', () => {
  it('loads and validates the built-in defaults', () => {
    const c = loadConfig()
    expect(Object.keys(c.roles.roles)).toEqual([
      'manager',
      'designer',
      'planner',
      'worker',
      'user',
      'viewer',
    ])
    expect(c.views.views.default?.rules?.length).toBeGreaterThan(5)
    expect(c.zooms.zooms.FULL).toBeDefined()
    expect(c.kinds.kinds.root?.schemas.design).toBe('root-design')
    expect(c.schemas['component-design']?.sections.some((s) => s.name === 'interface')).toBe(true)
    expect(c.rules['rules/worker.md']).toContain('worker')
  })

  it('merges override layers: objects deep, arrays replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hafiz-cfg-'))
    mkdirSync(join(dir, 'schemas'))
    writeFileSync(join(dir, 'hafiz.yaml'), 'tokenizer: { soft_zone: 0.2 }\n')
    writeFileSync(
      join(dir, 'roles.yaml'),
      'roles:\n  reviewer: { view: default, tools: [context.*], rules: rules/reviewer.md }\n',
    )
    const c = loadConfig([dir])
    expect(c.hafiz.tokenizer.soft_zone).toBe(0.2)
    expect(c.hafiz.tokenizer.name).toBe('estimator') // untouched sibling key survives
    expect(c.roles.roles.reviewer?.tools).toEqual(['context.*'])
    expect(c.roles.roles.manager).toBeDefined() // existing roles kept
  })

  it('ships every review row as queue, approved by the user', () => {
    expect(loadConfig().policies.review).toEqual({
      design: 'queue',
      plan: 'queue',
      done: 'queue',
      drafts: 'queue',
      approver: 'user',
    })
    expect(loadConfig().deprecations).toEqual([])
  })

  it('maps a retired confirm_done onto review.done, with a deprecation note', () => {
    const ask = mkdtempSync(join(tmpdir(), 'hafiz-cfg-'))
    writeFileSync(join(ask, 'hafiz.yaml'), 'confirm_done: ask\n')
    const c = loadConfig([ask])
    expect(c.policies.review.done).toBe('gate')
    expect(c.deprecations.join()).toMatch(
      /confirm_done: ask is retired; read as policies.yaml review.done: gate/,
    )
    const auto = mkdtempSync(join(tmpdir(), 'hafiz-cfg-'))
    writeFileSync(join(auto, 'hafiz.yaml'), 'confirm_done: auto\n')
    writeFileSync(
      join(auto, 'policies.yaml'),
      'status: { guards: { to_done: [children_closed, confirm_done] } }\n',
    )
    const a = loadConfig([auto])
    expect(a.policies.review.done).toBe('queue')
    expect(a.policies.status.guards.to_done).toEqual(['children_closed', 'review_done'])
    // a layer that already sets review.done keeps it
    writeFileSync(join(auto, 'policies.yaml'), 'review: { done: off }\n')
    expect(loadConfig([auto]).policies.review.done).toBe('off')
  })

  it('rejects gate for drafts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hafiz-cfg-'))
    writeFileSync(join(dir, 'policies.yaml'), 'review: { drafts: gate }\n')
    expect(() => loadConfig([dir])).toThrow(/review.drafts cannot be gate/)
  })

  it('mergeLayers replaces arrays', () => {
    expect(mergeLayers({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } })).toEqual({
      a: [3],
      b: { c: 1, d: 2 },
    })
  })
})
