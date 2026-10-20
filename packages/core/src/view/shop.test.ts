// Fixture A — the worked example — under three roles, plus explain and determinism.
import { describe, expect, it } from 'vitest'
import { Core } from '../commands/core.js'
import { loadConfig } from '../config/load.js'
import type { Actor } from '../domain/types.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { buildView, explain, readBlock } from './engine.js'
import { fixtureActor } from './fixtures/builder.js'
import { expectGolden, viewGolden } from './fixtures/golden.js'
import { SHOP, shopFixture } from './fixtures/shop.js'
import { loadSnapshot } from './snapshot.js'

const config = loadConfig()

async function view(role: string, blocks: string[]) {
  const f = await shopFixture()
  const snap = await loadSnapshot(f.backend.read)
  const v = buildView(snap, config, estimatorTokenizer, {
    role,
    focus: { blocks, computed: false },
  })
  return { f, snap, v }
}

async function coreWith(role: string, sessionId: string, spawnedBlock?: string) {
  const f = await shopFixture()
  const core = new Core({ config, backend: f.backend, clock: f.clock })
  await core.sessionOpen({
    id: sessionId,
    host: 'test',
    role,
    ...(spawnedBlock ? { spawnedBlock } : {}),
  })
  const by: Actor = { sessionId, role }
  return { f, core, by }
}

describe('fixture A (shop)', () => {
  it('worker focused on Payments', async () => {
    const { v } = await view('worker', [SHOP.payments])
    expectGolden('shop-worker-payments.md', viewGolden(v))
    const zoomOf = (b: string) => v.manifest.find((m) => m.block === b)?.zoom
    expect(zoomOf(SHOP.payments)).toBe('FULL')
    expect(zoomOf(SHOP.auth)).toBe('DIGEST') // done dependency
    expect(zoomOf(SHOP.invoices)).toBe('DIGEST')
    expect(zoomOf(SHOP.billing)).toBe('DESIGN') // ancestor
    expect(zoomOf(SHOP.reporting)).toBe('LINE')
    expect(v.text).not.toContain('Use Adyen') // superseded decisions render nowhere
    expect(v.text).not.toContain('Never log or persist') // standing decisions live in the floor
    expect(v.floorText).toContain('Never log or persist card numbers')
    expect(v.text).toMatch(/^<hafiz hash="[0-9a-f]{12}" role="worker">\n/)
  })

  it('manager focused on Payments and Reporting: max zoom wins per block', async () => {
    const { v, snap } = await view('manager', [SHOP.payments, SHOP.reporting])
    expectGolden('shop-manager-payments-reporting.md', viewGolden(v))
    // Billing is an ancestor of Payments (DESIGN) and a sibling of Reporting (LINE)
    expect(v.manifest.find((m) => m.block === SHOP.billing)).toMatchObject({
      relation: 'ancestor',
      zoom: 'DESIGN',
    })
    expectGolden('shop-manager-explain-billing.txt', `${explain(v, snap, SHOP.billing).text}\n`)
  })

  it('designer with the default (computed) focus', async () => {
    const { core, by } = await coreWith('designer', 'd1')
    const s = await core.backend.read.getSession('d1')
    expect(s?.focus.blocks).toEqual([SHOP.billing, SHOP.payments])
    const v = await core.contextFor(by)
    const {
      trace: _t,
      view: _v,
      ...rest
    } = buildView(await core.snapshot(), config, estimatorTokenizer, {
      role: 'designer',
      focus: s?.focus ?? { blocks: [], computed: true },
    })
    expect(v.hash).toBe(rest.hash)
    expectGolden('shop-designer-default.md', viewGolden(rest))
  })

  it('renders a single block at each zoom for block.read', async () => {
    const { snap } = await view('worker', [])
    const out = ['FULL', 'DESIGN', 'INTERFACE', 'DIGEST', 'LINE', 'NONE']
      .map((z) => `<!-- ${z} -->\n${readBlock(snap, config, SHOP.payments, z)}`)
      .join('\n\n')
    expectGolden('shop-block-read-payments.md', `${out}\n`)
  })

  it('is deterministic: same input, byte-identical output', async () => {
    const a = (await view('worker', [SHOP.payments])).v
    const b = (await view('worker', [SHOP.payments])).v
    expect(a.text).toBe(b.text)
    expect(a.floorText).toBe(b.floorText)
    expect(a.hash).toBe(b.hash)
  })

  it('re-emits only when the view changes', async () => {
    const { f, core, by } = await coreWith('worker', 'w1', SHOP.payments)
    const first = await core.contextFor(by)
    expect(first.changed).toBe(true)
    expect((await core.contextFor(by)).changed).toBe(false)

    // minor write on an unrelated block: same hash, no re-emission
    await f.progress(SHOP.reporting, 'found', 'dashboards need a nightly replica')
    const second = await core.contextFor(by)
    expect(second.hash).toBe(first.hash)
    expect(second.changed).toBe(false)

    // design change in a dependency's interface: new hash
    const mgr = fixtureActor('designer', 'designer')
    await core.docPatch(mgr, {
      block: SHOP.auth,
      type: 'design',
      sections: {
        interface: { provides: [{ name: 'verifySession(token, scope)', type: 'fn' }] },
      },
    })
    const third = await core.contextFor(by)
    expect(third.changed).toBe(true)
    expect(third.hash).not.toBe(first.hash)
    expect(third.text).toContain('verifySession(token, scope)')
    expect((await core.backend.read.getSession('w1'))?.lastViewHash).toBe(third.hash)
  })

  it('explains through Core for a session', async () => {
    const { core, by } = await coreWith('worker', 'w1', SHOP.payments)
    const e = await core.contextExplain(by, SHOP.invoices)
    expect(e.text).toContain('rule 4 { relation: dependency, status: done } → DIGEST')
    expect(e.trace.finalZoom).toBe('DIGEST')
    expect(await core.blockRead(by, SHOP.auth, 'LINE')).toBe('# Auth [auth] done')
  })
})
