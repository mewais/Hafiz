// Policy, relate and engine edge cases on small hand-built trees.
import { describe, expect, it } from 'vitest'
import { loadConfig, mergeLayers } from '../config/load.js'
import { type Config, configSchema } from '../config/schema.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { buildView, computeBudget } from './engine.js'
import { FixtureBuilder } from './fixtures/builder.js'
import { applyRules, matches, parseSelector, resolveView, ZoomOrder } from './policy.js'
import { relateTo } from './relate.js'
import { formatSection } from './render.js'
import { loadSnapshot } from './snapshot.js'

const config = loadConfig()
const withConfig = (over: Record<string, unknown>): Config =>
  configSchema.parse(mergeLayers(structuredClone(config) as never, over))

/** root → a → {a1, a2}, b → b1; a1 depends on b1 and a2; b1 depends on b. */
async function small() {
  const f = new FixtureBuilder()
  await f.project('Root', 'root')
  for (const [id, parent, status] of [
    ['a', 'root', 'active'],
    ['a1', 'a', 'active'],
    ['a2', 'a', 'planned'],
    ['b', 'root', 'active'],
    ['b1', 'b', 'done'],
  ] as const)
    await f.block({ id, parent, title: id.toUpperCase(), status })
  await f.edge('a1', 'b1')
  await f.edge('a1', 'a2')
  await f.edge('b1', 'b')
  return { f, snap: await loadSnapshot(f.backend.read) }
}

describe('policy', () => {
  it('resolves extends, budget merge and rules_prepend', () => {
    const worker = resolveView(config, 'worker')
    expect(worker.chain).toEqual(['worker', 'default'])
    expect(worker.budget).toEqual({ share_of_window: 0.2, min_tokens: 3000, max_tokens: 24000 })
    expect(worker.rules).toEqual(resolveView(config, 'default').rules)
    const designer = resolveView(config, 'designer')
    expect(designer.rules[0]).toEqual({
      match: { relation: 'descendant', status: 'planned' },
      zoom: 'DESIGN',
    })
    expect(designer.rules.length).toBe(worker.rules.length + 1)
    expect(designer.degrade).toEqual(worker.degrade)
  })

  it('rejects extends cycles and unknown views', () => {
    const c = withConfig({ views: { views: { x: { extends: 'y' }, y: { extends: 'x' } } } })
    expect(() => resolveView(c, 'x')).toThrow(/cycle/)
    expect(() => resolveView(config, 'nope')).toThrow(/unknown view/)
  })

  it('matches scalars, lists (any-of) and numbers; missing attributes never match', () => {
    const a = { relation: 'dependency', status: 'done', dep_distance: 1 }
    expect(matches({ relation: 'dependency' }, a)).toBe(true)
    expect(matches({ relation: ['root', 'dependency'] }, a)).toBe(true)
    expect(matches({ relation: ['root', 'focus'] }, a)).toBe(false)
    expect(matches({ dep_distance: 1, status: 'done' }, a)).toBe(true)
    expect(matches({ dep_distance: 2 }, a)).toBe(false)
    expect(matches({ kind: 'component' }, a)).toBe(false)
    expect(matches({}, a)).toBe(true)
  })

  it('first matching rule wins', () => {
    const rules = resolveView(config, 'default').rules
    expect(applyRules(rules, { relation: 'dependency', status: 'done' }, 'NONE').zoom).toBe(
      'DIGEST',
    )
    expect(
      applyRules(rules, { relation: 'dependency', status: 'active', dep_distance: 1 }, 'NONE'),
    ).toMatchObject({ index: 5, zoom: 'INTERFACE' })
    expect(applyRules(rules, { relation: 'root', status: 'active' }, 'NONE')).toMatchObject({
      zoom: 'DESIGN',
      floor: 'DESIGN',
    })
    expect(applyRules(rules, { relation: 'other', status: 'planned' }, 'NONE').label).toBe(
      'default: LINE',
    )
  })

  it('orders zooms by zooms.yaml key order', () => {
    const z = new ZoomOrder(config)
    expect(z.names).toEqual(['FULL', 'DESIGN', 'INTERFACE', 'DIGEST', 'LINE', 'NONE'])
    expect(z.max('LINE', 'DESIGN', 'DIGEST')).toBe('DESIGN')
    expect(z.min('LINE', 'DESIGN')).toBe('LINE')
    expect(() => z.rank('HUGE')).toThrow(/unknown zoom/)
  })

  it('parses every selector in zooms.yaml and rejects unknown ones', () => {
    expect(parseSelector('progress[-10:]')).toEqual({ kind: 'progress', last: 10 })
    expect(parseSelector('decisions.active[-3:]')).toEqual({ kind: 'decisions.active', last: 3 })
    expect(parseSelector('design.interface')).toEqual({
      kind: 'doc',
      doc: 'design',
      section: 'interface',
    })
    expect(parseSelector('digest.*')).toEqual({ kind: 'doc', doc: 'digest', section: '*' })
    expect(() => parseSelector('design')).toThrow(/unknown view selector/)
  })

  it('computes the budget from the window and clamps it', () => {
    const c = withConfig({ hafiz: { windows: { default: 200000, small: 8000 } } })
    const b = resolveView(c, 'worker').budget
    expect(computeBudget(c, b)).toBe(24000) // 0.2 × 200k = 40k, clamped to max
    expect(computeBudget(c, b, { model: 'small' })).toBe(3000) // 1.6k, clamped to min
    expect(computeBudget(c, b, { model: 'unknown' })).toBe(24000)
    expect(computeBudget(c, b, { budgetTokens: 123 })).toBe(123)
  })
})

describe('relate', () => {
  it('assigns relations with precedence and bounded dependency distance', async () => {
    const { snap } = await small()
    const rel = (f: string | null, depth = 2) =>
      Object.fromEntries([...relateTo(snap, f, depth)].map(([id, r]) => [id, r]))
    expect(rel('a1')).toEqual({
      root: { relation: 'root' },
      a: { relation: 'ancestor' },
      a1: { relation: 'focus' },
      a2: { relation: 'dependency', dep_distance: 1 }, // dependency beats sibling
      b: { relation: 'dependency', dep_distance: 2 },
      b1: { relation: 'dependency', dep_distance: 1 },
    })
    expect(rel('a1', 1).b).toEqual({ relation: 'other' })
    expect(rel('b1')).toMatchObject({
      a1: { relation: 'dependent' },
      b: { relation: 'ancestor', dep_distance: 1 }, // ancestor beats dependency
      a: { relation: 'other' },
    })
    expect(rel('a')).toMatchObject({ a1: { relation: 'descendant' }, b: { relation: 'sibling' } })
    expect(rel(null)).toMatchObject({ root: { relation: 'root' }, a: { relation: 'other' } })
  })
})

describe('engine', () => {
  it('aggregates a multi-block focus by max zoom and keeps paths to visible blocks', async () => {
    const { snap } = await small()
    const v = buildView(snap, config, estimatorTokenizer, {
      role: 'manager',
      focus: { blocks: ['a1', 'b1'], computed: false },
    })
    const z = Object.fromEntries(v.manifest.map((m) => [m.block, `${m.relation}:${m.zoom}`]))
    expect(z).toEqual({
      root: 'root:DESIGN',
      a: 'ancestor:DESIGN',
      a1: 'focus:FULL',
      a2: 'dependency:INTERFACE',
      b: 'ancestor:DESIGN',
      b1: 'focus:FULL',
    })
  })

  it('shows a NONE parent as a connector line when a descendant is visible', async () => {
    const f = new FixtureBuilder()
    await f.project('Root', 'root')
    await f.block({ id: 'gone', parent: 'root', title: 'Gone', status: 'dropped' })
    await f.block({ id: 'kept', parent: 'gone', title: 'Kept', status: 'done' })
    await f.block({ id: 'w', parent: 'root', title: 'W', status: 'active' })
    await f.edge('w', 'kept')
    const snap = await loadSnapshot(f.backend.read)
    const v = buildView(snap, config, estimatorTokenizer, {
      role: 'worker',
      focus: { blocks: ['w'], computed: false },
    })
    expect(v.manifest.find((m) => m.block === 'gone')?.zoom).toBe('LINE')
    expect(v.trace.get('gone')?.connector).toBe(true)
    expect(v.text).toContain('## Gone [gone] dropped\n### Kept [kept] done · dependency')
  })

  it('never degrades below a rule floor and warns about unknown focus blocks', async () => {
    const { snap } = await small()
    const v = buildView(snap, config, estimatorTokenizer, {
      role: 'worker',
      focus: { blocks: ['a1', 'zzz'], computed: false },
      budgetTokens: 1,
    })
    expect(v.manifest.find((m) => m.block === 'root')?.zoom).toBe('DESIGN')
    expect(v.notices.map((n) => n.text)).toEqual([
      'focus block(s) not found: zzz',
      expect.stringMatching(/^focus too wide: \d+ tokens over budget/),
    ])
  })

  it('renders the floor separately and flags it over cap without degrading it', async () => {
    const { f } = await small()
    for (let i = 0; i < 25; i++)
      await f.decision('a', {
        id: `d${i}`,
        title: `rule ${i}`,
        decision: `Always follow house rule number ${i}, which is long enough to matter for the floor cap of the view.`,
        standing: 'always',
      })
    await f.decision('b1', {
      id: 'far',
      title: 'far',
      decision: 'Never do far things.',
      standing: 'never',
    })
    const snap = await loadSnapshot(f.backend.read)
    const v = buildView(snap, config, estimatorTokenizer, {
      role: 'worker',
      focus: { blocks: ['a1'], computed: false },
    })
    expect(v.floorText.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(25)
    expect(v.floorText).not.toContain('far things') // not root/focus/ancestor
    expect(v.floorTokens).toBeGreaterThan(600)
    expect(v.notices.map((n) => n.text)).toEqual([
      expect.stringMatching(/over the floor cap of 600; consolidate standing decisions$/),
    ])
  })

  it('hash covers the floor: a new standing decision changes it', async () => {
    const { f, snap } = await small()
    const opts = { role: 'worker', focus: { blocks: ['a1'], computed: false } }
    const before = buildView(snap, config, estimatorTokenizer, opts)
    await f.decision('root', {
      id: 's',
      title: 's',
      decision: 'Never push to main.',
      standing: 'never',
    })
    const after = buildView(await loadSnapshot(f.backend.read), config, estimatorTokenizer, opts)
    expect(after.text.replace(/hash="\w+"/, '')).toBe(before.text.replace(/hash="\w+"/, ''))
    expect(after.hash).not.toBe(before.hash)
  })

  it('formats every section format compactly and skips empty ones', () => {
    expect(formatSection('purpose', 'prose', 'x')).toBe('Purpose: x')
    expect(formatSection('purpose', 'prose', '  ')).toBe('')
    expect(formatSection('scope', 'list', ['a'])).toBe('Scope: a')
    expect(formatSection('scope', 'list', [])).toBe('')
    expect(
      formatSection('references', 'refs', [
        { label: 'a', ref: 'a' },
        { label: 'b', ref: 'u' },
      ]),
    ).toBe('References: a; b (u)')
    expect(formatSection('interface', 'structured', { provides: [], consumes: [] })).toBe('')
    expect(formatSection('interface_delta', 'list', ['x', 'y'])).toBe('Interface delta:\n- x\n- y')
  })
})
