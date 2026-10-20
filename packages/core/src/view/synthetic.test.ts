// Fixture B — a synthetic ~60-block tree at three budgets: generous, tight, absurdly tight.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { buildView, explain, type ViewResult } from './engine.js'
import { fixtureActor } from './fixtures/builder.js'
import { expectGolden, viewGolden } from './fixtures/golden.js'
import { syntheticFixture } from './fixtures/synthetic.js'
import { loadSnapshot } from './snapshot.js'

const config = loadConfig()

async function setup() {
  const tree = await syntheticFixture()
  const snap = await loadSnapshot(tree.builder.backend.read)
  // a manager watching three active features, in priority order
  const focus = { blocks: tree.activeFeatures.slice(0, 3), computed: false }
  const render = (budgetTokens?: number) =>
    buildView(snap, config, estimatorTokenizer, {
      role: 'manager',
      focus,
      ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    })
  return { tree, snap, focus, render }
}

const zoomOf = (v: ViewResult, b: string) => v.manifest.find((m) => m.block === b)?.zoom

describe('fixture B (synthetic, ~60 blocks)', () => {
  it('is about 60 blocks with three active focus blocks', async () => {
    const { tree, focus } = await setup()
    expect(tree.blocks.length).toBeGreaterThanOrEqual(55)
    expect(tree.blocks.length).toBeLessThanOrEqual(65)
    expect(focus.blocks).toHaveLength(3)
  })

  it('generous budget: nothing degrades', async () => {
    const { render, focus } = await setup()
    const v = render()
    expect(v.budget).toBe(24000)
    expect(v.notices).toEqual([])
    expect([...v.trace.values()].every((t) => t.effects.length === 0)).toBe(true)
    for (const b of focus.blocks) expect(zoomOf(v, b)).toBe('FULL')
    expectGolden('synthetic-generous.md', viewGolden(v))
  })

  it('tight budget: degrade steps apply in order, lowest-priority focus first', async () => {
    const { render, focus, snap } = await setup()
    const v = render(1700)
    expect(v.tokens).toBeLessThanOrEqual(1700)
    expect(v.notices).toEqual([])
    const [first, second, third] = focus.blocks as [string, string, string]
    expect(zoomOf(v, third)).toBe('DESIGN')
    expect(zoomOf(v, second)).toBe('DESIGN')
    expect(zoomOf(v, first)).toBe('FULL') // highest priority keeps full detail
    expect(zoomOf(v, snap.rootId as string)).toBe('DESIGN') // root's floor holds
    expectGolden('synthetic-tight.md', viewGolden(v))
    expectGolden('synthetic-tight-explain.txt', `${explain(v, snap, second).text}\n`)
  })

  it('absurdly tight budget: everything degrades to floors and says focus too wide', async () => {
    const { render, snap } = await setup()
    const v = render(600)
    expect(v.tokens).toBeGreaterThan(600)
    expect(v.notices.map((n) => n.text)).toEqual([
      `focus too wide: ${v.tokens - 600} tokens over budget; narrow focus or group under a parent block`,
    ])
    expect(v.text).toContain('> warn: focus too wide')
    expect(zoomOf(v, snap.rootId as string)).toBe('DESIGN')
    expect(v.floorText).toContain('vault client') // the floor is never degraded
    expectGolden('synthetic-absurd.md', viewGolden(v))
  })

  it('degrading is monotone in the budget', async () => {
    const { render } = await setup()
    let prev = Number.POSITIVE_INFINITY
    for (const b of [24000, 2500, 2000, 1700, 1200, 600]) {
      const t = render(b).tokens
      expect(t).toBeLessThanOrEqual(prev)
      prev = t
    }
  })

  it('a distant leaf’s progress does not change a worker’s hash; a dependency design does', async () => {
    const { tree } = await setup()
    const worker = tree.activeFeatures[1] as string
    const view = async () =>
      buildView(await loadSnapshot(tree.builder.backend.read), config, estimatorTokenizer, {
        role: 'worker',
        focus: { blocks: [worker], computed: true },
      })
    const before = await view()
    const distant = before.manifest.find(
      (m) =>
        m.zoom === 'LINE' &&
        m.relation === 'other' &&
        !m.block.startsWith(worker.split('-')[0] as string),
    )?.block as string
    expect(distant).toBeTruthy()
    await tree.builder.progress(distant, 'found', 'unrelated finding', {
      by: fixtureActor('worker', 'worker-9'),
    })
    await tree.builder.step(distant, 's1', 'doing')
    expect((await view()).hash).toBe(before.hash)

    const snap = await loadSnapshot(tree.builder.backend.read)
    const dep = snap.dependsOn.get(worker)?.[0] as string
    expect(dep).toBeTruthy()
    const design = snap.blocks.get(dep)?.docs.design?.sections ?? {}
    await tree.builder.doc(dep, 'design', {
      ...design,
      interface: { provides: [{ name: 'brandNewCall(id)', type: 'fn' }] },
    })
    const after = await view()
    expect(after.hash).not.toBe(before.hash)
    expect(after.text).toContain('brandNewCall(id)')
  })
})
