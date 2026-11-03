// Doc writes as agents make them: an existing document needs the version the writer saw, and a
// design's interface.consumes is the source of the block's dependency edges.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import { ForbiddenError, ValidationError } from '../domain/errors.js'
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
    await core.docWrite(des, { block: c, type: 'design', sections: design([]) })
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

describe('inline docs and patches never bypass the writers', () => {
  const mgr: Actor = { sessionId: 'm1', role: 'manager', agent: 'manager' }
  const plan = { steps: [{ id: 's1', title: 'x' }], acceptance: ['ok'] }

  it('block.create refuses an inline design or plan without the doc.write grant', async () => {
    const { core, root } = await setup()
    const d = design([])
    await expect(
      core.blockCreate(mgr, { parent: root, title: 'X', design: d }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(core.blockCreate(mgr, { parent: root, title: 'X', plan })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(core.blockCreate(des, { parent: root, title: 'X', plan })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    expect(
      (await core.blockCreate(des, { parent: root, title: 'D', design: d })).result.docVersions
        .design,
    ).toBe(1)
    expect(
      (await core.blockCreate(user, { parent: root, title: 'U', design: d, plan })).result
        .docVersions.plan,
    ).toBe(1)
    expect((await core.blockCreate(mgr, { parent: root, title: 'Plain' })).result.title).toBe(
      'Plain',
    )
  })

  it('doc.patch adjusts an existing doc and never creates one', async () => {
    const { core, a } = await setup()
    await expect(core.docPatch(mgr, { block: a, type: 'plan', sections: plan })).rejects.toThrow(
      /no plan on .* yet; the planner writes it, or use doc.write/,
    )
    await expect(
      core.docPatch(des, { block: a, type: 'design', sections: design([]) }),
    ).rejects.toThrow(/no design on .* yet; the designer writes it/)
    // the agent tool's patch may start a doc only for a role holding doc.write
    expect(
      (await core.docPatch(des, { block: a, type: 'design', sections: design([]), create: true }))
        .result.version,
    ).toBe(1)
    await core.docWrite(user, { block: a, type: 'plan', sections: plan })
    expect(
      (await core.docPatch(mgr, { block: a, type: 'plan', sections: { acceptance: ['b'] } })).result
        .version,
    ).toBe(2)
    await expect(
      core.docPatch(mgr, {
        block: core_b(await core.backend.read.listBlocks()),
        type: 'plan',
        sections: plan,
        create: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

const core_b = (bs: Array<{ id: string; title: string }>) =>
  bs.find((b) => b.title === 'Billing')?.id as string
