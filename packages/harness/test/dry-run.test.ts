// Dry run of the smoke tasks' first turn without a model: the L seed in Core, then each step a
// careful manager would take, checking what every role sees (its view) and what the spawn checks
// say, so a run on a real model cannot fail on a view that hides the next step.
import {
  type Actor,
  Core,
  fixedClock,
  loadConfig,
  MemoryBackend,
  type TreeSummary,
} from '@hafiz/core'
import type { DaemonClient } from '@hafiz/gateway-mcp'
import { createChecks } from '@hafiz/host-kilo'
import { describe, expect, it } from 'vitest'
import { seedTree } from '../src/seed.js'
import { loadTasks } from '../src/tasks.js'

const config = loadConfig()
const PRINT = !!process.env.HAFIZ_DRY_RUN_PRINT
const show = (t: string, s: string) => PRINT && console.log(`\n===== ${t}\n${s}`)

async function seeded(taskId: string) {
  const task = loadTasks(undefined, [taskId])[0]
  if (!task) throw new Error(taskId)
  const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
  const user: Actor = { sessionId: 'u', role: 'user' }
  const { result } = await core.projectInit(user, {
    name: 'Toy Shop',
    originFingerprint: 'fp',
    onboarding: true,
  })
  const client = {
    dispatch: (command: string, args: Record<string, unknown>) =>
      core.dispatch(user, command, args),
  } as unknown as DaemonClient
  const b = await seedTree(client, result.root.id, task.setup.seed, { root: result.root.id })
  const as = (role: string, id: string): Actor => ({ sessionId: id, role })
  const open = async (id: string, role: string, block?: string) => {
    await core.sessionOpen({ id, host: 'kilo', role, ...(block ? { spawnedBlock: block } : {}) })
    return as(role, id)
  }
  const view = async (a: Actor) => {
    const v = await core.contextFor(a)
    show(`${a.role} ${a.sessionId}`, v.text)
    return v.text
  }
  const m = await open('m', 'manager')
  const checks = createChecks({
    config,
    storeDir: '/store',
    sessions: {
      isManaged: () => true,
      get: () => ({ role: 'manager' }),
      isRoleAgent: (a) => !!a && ['designer', 'planner', 'worker'].includes(a),
      roleFor: (a) => a,
      call: async <T>() => (await core.treeSummary(m, { recentDecisions: 0 })) as T,
    },
  })
  const spawn = async (agent: string, block: string): Promise<string> => {
    try {
      await checks.before(
        { tool: 'task', sessionID: 'm' },
        { args: { subagent_type: agent, block, prompt: 'go' } },
      )
      return 'ok'
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  return { core, b, m, open, view, spawn, task }
}

const line = (text: string, id: string) => text.split('\n').find((l) => l.includes(`[${id}]`))

describe('dry run: L, turn 1 (seeded tree, queue reviews)', () => {
  it('walks onboarding, the Checkout refinement, the planner and three workers', async () => {
    const { core, b, m, open, view, spawn } = await seeded('l-seeded-tree')
    const totals = b.totals as string
    const pricing = b.pricing as string
    const orders = b.orders as string

    // the manager: onboarding is due (the seed is tracked work), and each block says what it needs
    let mv = await view(m)
    expect(mv).toContain('Onboarding pending')
    expect(line(mv, pricing)).toMatch(/planned · needs plan/)
    expect(line(mv, orders)).toMatch(/planned · needs plan/)
    expect(line(mv, totals)).toMatch(/planned$/) // designed and planned: a worker may start
    // the seeded designs derive the edges the workers' views follow
    expect(mv).toMatch(/Depends on: .*money/)

    // spawn fit: refusals name the next step
    expect(await spawn('worker', pricing)).toMatch(/no plan yet, so the planner goes next/)
    expect(await spawn('designer', b.root as string)).toBe('ok')
    expect(await spawn('designer', b.checkout as string)).toBe('ok')
    expect(await spawn('planner', pricing)).toBe('ok')
    expect(await spawn('worker', totals)).toBe('ok')

    // onboarding designer on the root: describes the code, which clears the directive
    const d0 = await open('d0', 'designer', b.root)
    await core.dispatch(d0, 'doc.write', {
      block: b.root,
      type: 'design',
      sections: { overview: 'A shop library.', topology: ['cart -> money'] },
    })
    await core.sessionEnd('d0')
    mv = await view(m)
    expect(mv).not.toContain('Onboarding pending')

    // the Checkout designer sees the leaves' designs (planned descendants at DESIGN)
    const d1 = await open('d1', 'designer', b.checkout)
    const dv = await view(d1)
    expect(dv).toContain('priceCart(cart: Cart, rules?: PriceRule[]): PricedCart')
    expect(dv).toContain('Orders.placeOrder(cart: Cart): PricedOrder')
    await core.sessionEnd('d1')

    // the planner on Pricing sees the design it plans and the interfaces it plans against
    const p = await open('p', 'planner', pricing)
    const pv = await view(p)
    expect(pv).toContain('priceCart(cart: Cart, rules?: PriceRule[]): PricedCart')
    expect(pv).toContain('Cart.totalCents(): number') // its dependency, Cart
    expect(line(pv, orders)).toMatch(/needs plan/) // and that Orders still needs one
    const plan = { steps: [{ id: 's1', title: 'Do it' }], acceptance: ['npm test passes'] }
    for (const block of [pricing, orders])
      await core.dispatch(p, 'doc.write', { block, type: 'plan', sections: plan })
    await core.sessionEnd('p')
    // a spawn on a planned block is not work started
    expect((await core.backend.read.getBlock(pricing))?.status).toBe('planned')

    // the manager now sees that every leaf can take a worker; queue-mode reviews are not gates
    mv = await view(m)
    for (const id of [totals, pricing, orders]) expect(line(mv, id)).not.toMatch(/needs|review/)
    expect(await spawn('worker', orders)).toBe('ok')
    const listed = await core.reviewList(m, 'pending', true)
    expect(listed.filter((x) => x.source === 'review')).toEqual([])

    // three workers: each spawn activates its block; each sees its plan steps and interfaces
    for (const [id, block] of [
      ['w1', totals],
      ['w2', pricing],
      ['w3', orders],
    ] as const) {
      const w = await open(id, 'worker', block)
      expect((await core.backend.read.getBlock(block))?.status).toBe('active')
      const wv = await view(w)
      expect(line(wv, block)).toMatch(/active · focus/)
      expect(wv).toMatch(/Steps:\n- \[ \] s1 /)
      expect(wv).toContain('Interface:')
      const digest = {
        outcome: 'Implemented.',
        interface_delta: ['none'],
        pointers: [{ label: 'file', ref: 'src/x.ts' }],
      }
      const r = await core.dispatch(w, 'block.request_done', { id: block, digest })
      expect(r.result).toMatchObject({ queued: true }) // review.done: gate
    }
    // the Orders worker builds against Pricing's interface
    expect(await view({ sessionId: 'w3', role: 'worker' })).toContain('priceCart(')
    // the manager resolves the done requests it was told about
    const done = await core.reviewList(m, 'pending', true)
    expect(done.map((x) => x.kind)).toEqual(['status', 'status', 'status'])
    for (const x of done) await core.dispatch(m, 'proposal.accept', { id: x.id })
    const tree = (await core.treeSummary(m)) as TreeSummary
    for (const id of [totals, pricing, orders])
      expect(tree.nodes.find((n) => n.id === id)?.status).toBe('done')
  })
})

describe('dry run: M gated, turn 1 (untracked brownfield, design gate)', () => {
  it('a gated design holds only its own block, with the remedy in the refusal', async () => {
    const config2 = loadConfig()
    config2.policies.review.design = 'gate'
    config2.policies.review.plan = 'gate'
    const core = new Core({ config: config2, backend: new MemoryBackend(), clock: fixedClock() })
    const mgr: Actor = { sessionId: 'm', role: 'manager' }
    const { result } = await core.projectInit(mgr, {
      name: 'Toy Shop',
      originFingerprint: 'fp',
      onboarding: true,
    })
    await core.sessionOpen({ id: 'm', host: 'kilo', role: 'manager' })
    // nothing is asked before tracked work starts
    expect((await core.contextFor(mgr)).text).not.toContain('Onboarding pending')
    const feat = (
      await core.dispatch(mgr, 'block.create', {
        parent: result.root.id,
        title: 'Coupon codes',
        kind: 'feature',
      })
    ).result as { id: string }
    let mv = (await core.contextFor(mgr)).text
    expect(mv).toContain('Onboarding pending')
    expect(line(mv, feat.id)).toMatch(/planned · needs design · feature/)
    // the designer writes the feature design and a child: both wait for the user
    await core.sessionOpen({ id: 'd', host: 'kilo', role: 'designer', spawnedBlock: feat.id })
    const d: Actor = { sessionId: 'd', role: 'designer' }
    const design = { purpose: 'p', scope: ['in: x'], interface: { provides: [], consumes: [] } }
    await core.dispatch(d, 'doc.write', { block: feat.id, type: 'design', sections: design })
    await core.dispatch(d, 'block.create', { parent: feat.id, title: 'Catalogue', design })
    await core.sessionEnd('d')
    mv = (await core.contextFor(mgr)).text
    show('manager, design gate', mv)
    expect(line(mv, feat.id)).toMatch(/review design/)
    // the design reviews belong to the user: the manager's list does not show them as its job
    expect(
      (await core.reviewList(mgr, 'pending', true)).filter((x) => x.source === 'review'),
    ).toEqual([])
  })
})
