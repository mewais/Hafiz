// Doc writes as agents make them: an existing document needs the version the writer saw, and a
// design's interface.consumes is the source of the block's dependency edges.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import { ValidationError } from '../domain/errors.js'
import type { Actor } from '../domain/types.js'
import { MemoryBackend } from '../store/memory.js'
import { Core } from './core.js'

const des: Actor = { sessionId: 'd1', role: 'designer', agent: 'designer' }
const user: Actor = { sessionId: 'u', role: 'user' }

async function setup() {
  const core = new Core({ config: loadConfig(), backend: new MemoryBackend(), clock: fixedClock() })
  const { result } = await core.projectInit(user, { name: 'Shop', originFingerprint: 'fp' })
  const root = result.root.id
  const mk = async (title: string) =>
    (await core.blockCreate(user, { parent: root, title })).result.id
  return { core, root, a: await mk('Auth'), b: await mk('Billing'), c: await mk('Checkout') }
}

const design = (consumes: Array<{ name: string; block?: string }>) => ({
  purpose: 'p',
  scope: ['in: x'],
  interface: { provides: [{ name: 'f()' }], consumes },
})

describe('doc versions for agent writes', () => {
  it('a first write needs no version; an existing doc needs the one the writer saw', async () => {
    const { core, c } = await setup()
    const w = (sections: Record<string, unknown>, expectedVersion?: number) =>
      core.docPatch(des, {
        block: c,
        type: 'design',
        sections: sections as never,
        requireVersion: true,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      })
    await w(design([]))
    const e = await w({ purpose: 'q' }).catch((x) => x)
    expect(e).toBeInstanceOf(ValidationError)
    expect(e.message).toMatch(/already exists \(version 1\): pass expected_version: 1/)
    expect(e.details.current).toBe(1)
    expect((await w({ purpose: 'q' }, 1)).result.version).toBe(2)
    // the CLI and Hafiz itself write without the requirement
    await core.docPatch(user, { block: c, type: 'design', sections: { purpose: 'r' } })
  })
})

describe('dependencies derived from the design', () => {
  it('adds and removes depends_on edges as consumes changes; unknown names get a notice', async () => {
    const { core, a, b, c } = await setup()
    const edges = async () =>
      (await core.backend.read.listEdges())
        .filter((e) => e.from === c)
        .map((e) => `${e.kind}:${e.to}`)
        .sort()
    const write = (consumes: Array<{ name: string; block?: string }>) =>
      core.docWrite(des, { block: c, type: 'design', sections: design(consumes) })

    // by id, and by a title that names exactly one block
    await write([
      { name: 'verify()', block: a },
      { name: 'charge()', block: 'Billing' },
    ])
    expect(await edges()).toEqual([`depends_on:${a}`, `depends_on:${b}`])

    // dropping a consumer removes its edge; entries without a block add nothing
    let r = await write([{ name: 'charge()', block: b }, { name: 'log()' }])
    expect(await edges()).toEqual([`depends_on:${b}`])
    expect(r.notices.map((n) => n.text).join('\n')).not.toMatch(/no known block/)

    // an unknown provider is a notice naming it, not an error; known ones still apply
    r = await write([
      { name: 'ship()', block: 'Shipping' },
      { name: 'verify()', block: a },
    ])
    expect(await edges()).toEqual([`depends_on:${a}`])
    expect(r.notices.map((n) => n.text).join('\n')).toMatch(/no known block: Shipping/)

    // a patch that leaves the interface alone keeps the edges; other edge kinds are untouched
    await core.edgeAdd(user, { from: c, to: b, kind: 'relates_to' })
    await core.docPatch(des, { block: c, type: 'design', sections: { purpose: 'new' } })
    expect(await edges()).toEqual([`depends_on:${a}`, `relates_to:${b}`])
    await write([])
    expect(await edges()).toEqual([`relates_to:${b}`])
  })

  it('the view shows the provider and the dependency', async () => {
    const { core, a, c } = await setup()
    await core.docWrite(des, {
      block: c,
      type: 'design',
      sections: design([{ name: 'verify(token)', block: a }]),
    })
    const text = await core.blockRead(des, c, 'FULL')
    expect(text).toContain(`consumes \`verify(token)\` from ${a}`)
    expect(text).toMatch(new RegExp(`Depends on: ${a}`))
  })
})
