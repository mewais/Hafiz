// Fixture B — a synthetic ~60-block tree for budget and degradation goldens. Deterministic:
// seeded PRNG, fixed clock, readable fixed ids.
import type { Contract, ProgressKind, Status, StepStatus } from '../../domain/types.js'
import { FixtureBuilder, fixtureActor } from './builder.js'

/** mulberry32: tiny seeded PRNG. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const AREAS: Array<[string, string, string[]]> = [
  ['ingest', 'Ingest', ['Parsers', 'Validation', 'Event store']],
  ['routing', 'Routing', ['Planner', 'Constraints', 'Optimiser']],
  ['fleet', 'Fleet', ['Telemetry', 'Dispatch', 'Maintenance']],
  ['portal', 'Portal', ['Accounts', 'Tracking page', 'Reports']],
]
const VERBS = ['Dedupe', 'Validate', 'Batch', 'Index', 'Expose', 'Cache', 'Reconcile', 'Throttle']
const NOUNS = [
  'shipment events',
  'carrier manifests',
  'stop windows',
  'vehicle pings',
  'route plans',
  'customer accounts',
  'delivery proofs',
  'depot schedules',
  'fuel reports',
  'tracking links',
]
const GOALS = [
  'downstream services never see duplicates',
  'planners get answers within a second',
  'operators can audit every change',
  'the nightly batch finishes before 05:00',
  'customers see accurate ETAs',
]
const CONSTRAINTS = [
  'Idempotent on retries',
  'No PII in logs',
  'p95 under 200 ms',
  'Backwards-compatible schema changes only',
  'Runs in a single region',
]
const FINDINGS = [
  'carrier timestamps arrive without zone offsets; normalise at the edge',
  'batch size above 500 trips the upstream rate limit',
  'the legacy depot feed repeats rows after midnight',
  'index on (tenant, ts) halves the scan time',
  'retry storms when the broker restarts; add jitter',
  'two carriers reuse manifest numbers across years',
  'schema v2 drops the depot code; map it from the stop id',
  'the geocoder returns 0,0 for unknown postcodes; treat as missing',
  'consumer lag spikes when the snapshot job runs; move it off-peak',
  'carrier sandbox rejects batches with mixed tenants',
  'ETA drift is mostly dwell time at depots, not travel time',
  'the tracking page polls every 2 s; switch to server-sent events',
]

const camel = (s: string) =>
  s.replace(/(?:^|\s)(\w)/g, (_, c: string, i: number) => (i ? c.toUpperCase() : c.toLowerCase()))

export interface SyntheticTree {
  builder: FixtureBuilder
  rootId: string
  blocks: string[]
  activeFeatures: string[]
  leaves: string[]
}

export async function syntheticFixture(seed = 7): Promise<SyntheticTree> {
  const r = rng(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  /** k distinct items, in random order. */
  const sample = <T>(xs: readonly T[], k: number): T[] => {
    const pool = [...xs]
    const out: T[] = []
    while (out.length < k && pool.length)
      out.push(pool.splice(Math.floor(r() * pool.length), 1)[0] as T)
    return out
  }
  const usedTitles = new Set<string>()
  const f = new FixtureBuilder('2026-04-01T08:00:00.000Z')
  const rootId = 'atlas'
  await f.project('Atlas', rootId, {
    overview:
      'Atlas plans and tracks parcel deliveries for regional carriers: ingest carrier data, plan routes, run the fleet and show customers where their parcel is.',
    topology: AREAS.map(([, t, cs]) => `${t}: ${cs.join(', ')}`),
    constraints: ['EU hosting only', 'Every service owns its schema'],
  })
  await f.decision(rootId, {
    id: 'dec-atlas-1',
    title: 'Messaging',
    decision: 'Services talk through the event bus; no synchronous calls across areas.',
    rationale: 'Areas deploy independently.',
  })
  await f.decision(rootId, {
    id: 'dec-atlas-2',
    title: 'Secrets',
    decision: 'Never read secrets from files in the repo; use the vault client.',
    standing: 'never',
  })

  const blocks: string[] = [rootId]
  const features: string[] = []
  const activeFeatures: string[] = []
  let n = 0
  const contract = (noun: string): Contract => ({
    name: `${camel(`${pick(['get', 'list', 'put', 'stream'])} ${noun}`).replace(/\s/g, '')}(${pick(['id', 'tenant', 'since'])})`,
    type: pick(['fn', 'event', 'http']),
  })
  const design = (title: string, noun: string) => ({
    purpose: `${title} for ${pick(NOUNS)} so that ${pick(GOALS)}.`,
    scope: [`in: ${noun}`, `out: ${pick(NOUNS)}`],
    interface: { provides: [contract(noun), contract(pick(NOUNS.filter((x) => x !== noun)))] },
    ...(r() < 0.5 ? { constraints: [pick(CONSTRAINTS)] } : {}),
  })

  for (const [ai, [aid, atitle, comps]] of AREAS.entries()) {
    await f.block({
      id: aid,
      parent: rootId,
      title: atitle,
      status: 'active',
      design: design(`${atitle} area`, NOUNS[ai] as string),
    })
    blocks.push(aid)
    if (ai === 1)
      await f.decision(aid, {
        id: `dec-${aid}-std`,
        title: 'Units',
        decision: 'Always use metres and seconds in APIs.',
        standing: 'always',
      })
    for (const [ci, ctitle] of comps.entries()) {
      const cid = `${aid}-${ctitle.toLowerCase().replace(/\s+/g, '-')}`
      const cstatus: Status = ci === 0 && ai % 2 === 0 ? 'done' : ci === 2 ? 'planned' : 'active'
      await f.block({
        id: cid,
        parent: aid,
        title: ctitle,
        status: cstatus,
        design: design(ctitle, pick(NOUNS)),
        ...(cstatus === 'done'
          ? {
              digest: {
                outcome: `${ctitle} shipped; ${pick(FINDINGS)}.`,
                interface_delta: ['none'],
                pointers: [
                  { label: `PR #${100 + n}`, ref: `github.com/atlas/app/pull/${100 + n}` },
                ],
              },
            }
          : {}),
      })
      blocks.push(cid)
      const count = 3 + (r() < 0.5 ? 1 : 0)
      for (let k = 1; k <= count; k++) {
        n++
        const id = `${cid}-${k}`
        let noun = pick(NOUNS)
        let title = `${pick(VERBS)} ${noun}`
        while (usedTitles.has(title)) {
          noun = pick(NOUNS)
          title = `${pick(VERBS)} ${noun}`
        }
        usedTitles.add(title)
        let status: Status = cstatus === 'active' ? pick(['done', 'active', 'planned']) : cstatus
        if (cstatus === 'active' && r() < 0.08) status = 'dropped'
        if (status === 'active' && r() < 0.15) status = 'blocked'
        const steps = Array.from({ length: 3 + Math.floor(r() * 3) }, (_, i) => ({
          id: `s${i + 1}`,
          title: `${pick(VERBS)} ${pick(NOUNS)}`,
        }))
        await f.block({
          id,
          parent: cid,
          title,
          status,
          ...(status === 'blocked'
            ? { blockedOn: { kind: 'external' as const, note: 'waiting on carrier API keys' } }
            : {}),
          design: design(title, noun),
          ...(status !== 'dropped'
            ? {
                plan: {
                  steps,
                  acceptance: [`${noun} round-trip test passes`, pick(CONSTRAINTS)],
                },
              }
            : {}),
          ...(status === 'done'
            ? {
                digest: {
                  outcome: `${title} is live; ${pick(FINDINGS)}.`,
                  interface_delta: [r() < 0.5 ? 'none' : `adds ${contract(noun).name}`],
                  pointers: [
                    { label: `PR #${200 + n}`, ref: `github.com/atlas/app/pull/${200 + n}` },
                  ],
                },
              }
            : {}),
        })
        blocks.push(id)
        features.push(id)
        if (status === 'active') activeFeatures.push(id)
        if (status === 'active' || status === 'blocked' || status === 'done') {
          const states: StepStatus[] =
            status === 'done'
              ? steps.map(() => 'done')
              : steps.map((_, i) => (i === 0 ? 'done' : i === 1 ? 'doing' : 'todo'))
          for (const [i, s] of steps.entries())
            if (states[i] !== 'todo') await f.step(id, s.id, states[i] as StepStatus)
          const entries = 2 + Math.floor(r() * 9)
          for (const text of sample(FINDINGS, entries))
            await f.progress(
              id,
              pick<ProgressKind>(['done', 'found', 'changed', 'question']),
              text.replace(/^./, (c) => c.toUpperCase()),
              { by: fixtureActor('worker', `worker-${1 + (n % 3)}`) },
            )
          if (r() < 0.6)
            await f.decision(id, {
              id: `dec-${id}`,
              title: `${title} approach`,
              decision: `${pick(VERBS)} ${pick(NOUNS)} in the ${pick(['edge', 'worker', 'database', 'client'])}.`,
              rationale: `${pick(GOALS)}.`.replace(/^./, (c) => c.toUpperCase()),
            })
          if (status !== 'done' && r() < 0.5)
            await f.thread(id, {
              id: `thr-${id}`,
              title: `${pick(NOUNS)} edge cases`.replace(/^./, (c) => c.toUpperCase()),
              entries: [`${pick(FINDINGS)}?`],
            })
          if (status !== 'done' && r() < 0.3)
            await f.thread(id, {
              id: `thr-${id}-p`,
              title: `Backfill ${pick(NOUNS)}`,
              status: 'parked',
              gist: 'Parked until the schema settles.',
            })
        }
      }
    }
  }
  // Dependencies point from later features to earlier ones in other components (acyclic).
  const component = (id: string) => id.slice(0, id.lastIndexOf('-'))
  for (const [i, id] of features.entries()) {
    const earlier = features.slice(0, i).filter((x) => component(x) !== component(id))
    if (!earlier.length) continue
    const k = activeFeatures.includes(id) ? 1 + (r() < 0.5 ? 1 : 0) : r() < 0.3 ? 1 : 0
    for (const target of sample(earlier, k)) await f.edge(id, target)
  }
  const leaves = features
  return { builder: f, rootId, blocks, activeFeatures, leaves }
}
