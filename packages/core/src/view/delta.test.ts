// Delta channel: minor events on focus + dependencies since the session's cursor.
import { describe, expect, it } from 'vitest'
import { Core } from '../commands/core.js'
import { loadConfig, mergeLayers } from '../config/load.js'
import { configSchema } from '../config/schema.js'
import type { Actor } from '../domain/types.js'
import { fixtureActor } from './fixtures/builder.js'
import { expectGolden } from './fixtures/golden.js'
import { SHOP, shopFixture, worker2 } from './fixtures/shop.js'

const base = loadConfig()

async function setup(capTokens?: number) {
  const config =
    capTokens === undefined
      ? base
      : configSchema.parse(
          mergeLayers(structuredClone(base) as never, {
            tail: { delta: { cap_tokens: capTokens } },
          }),
        )
  const f = await shopFixture()
  const core = new Core({ config, backend: f.backend, clock: f.clock })
  await core.sessionOpen({ id: 'w1', host: 'test', role: 'worker', spawnedBlock: SHOP.payments })
  const by: Actor = { sessionId: 'w1', role: 'worker', agent: 'worker-1' }
  return { f, core, by }
}

describe('context.delta', () => {
  it('delivers minor events on focus and dependencies once, then advances the cursor', async () => {
    const { f, core, by } = await setup()
    await core.contextFor(by) // initialises the cursor: the view already holds history
    const start = (await core.backend.read.getSession('w1'))?.deltaCursor
    expect(start).toBe(await core.backend.read.currentSeq())
    expect((await core.contextDelta(by)).text).toBe('')

    await f.progress(SHOP.invoices, 'changed', 'markPaid now rejects void invoices', {
      by: worker2,
    })
    await f.progress(SHOP.reporting, 'found', 'out of scope for this worker', { by: worker2 })
    await f.progress(SHOP.payments, 'done', 'my own note is not echoed back', { by })
    await f.step(SHOP.payments, 's3', 'done', worker2)
    await f.step(SHOP.payments, 's4', 'doing', worker2)
    await f.step(SHOP.payments, 's4', 'done', worker2) // supersedes the previous event
    await f.thread(SHOP.auth, {
      id: 'thr-ttl',
      title: 'Session TTL for staff',
      entries: ['Staff sessions should expire after 8 hours.'],
    })
    await f.progress(SHOP.payments, 'found', 'Stripe test clock helps with SEPA timing', {
      by: worker2,
      refs: ['docs/stripe.md'],
    })

    const d = await core.contextDelta(by)
    expectGolden('shop-delta-worker.md', `${d.text}\n`)
    expect(d.text).not.toContain('out of scope')
    expect(d.text).not.toContain('not echoed')
    expect(d.text).not.toContain('s4 → doing')
    expect(d.cursor).toBe(await core.backend.read.currentSeq())
    expect((await core.backend.read.getSession('w1'))?.deltaCursor).toBe(d.cursor)
    expect((await core.contextDelta(by)).text).toBe('')
  })

  it('caps the delta and points at block.read for the rest', async () => {
    const { f, core, by } = await setup(60)
    await core.contextFor(by)
    for (let i = 1; i <= 10; i++)
      await f.progress(SHOP.invoices, 'found', `finding number ${i} about invoice numbering`, {
        by: fixtureActor('worker', 'worker-3'),
      })
    const d = await core.contextDelta(by)
    expect(d.shown).toBeGreaterThan(0)
    expect(d.shown + d.withheld).toBe(10)
    expect(d.text).toContain(`- ${d.withheld} more — block.read(${SHOP.invoices})`)
    expect(d.text).toContain('finding number 1 ')
    expect(d.text).not.toContain('finding number 10 ')
  })

  it('requires an existing session', async () => {
    const { core } = await setup()
    await expect(core.contextDelta({ sessionId: 'nope', role: 'worker' })).rejects.toThrow(
      /session/,
    )
  })
})
