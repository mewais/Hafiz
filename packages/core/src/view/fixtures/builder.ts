// Deterministic fixture builder for view-engine tests: writes straight through the memory
// backend with caller-chosen ids and a fixed clock (no random slugs).
import { type Clock, fixedClock } from '../../domain/clock.js'
import type {
  Actor,
  Block,
  BlockId,
  Decision,
  DocType,
  ProgressKind,
  SectionValue,
  Standing,
  Status,
  StepStatus,
  Thread,
  ThreadStatus,
} from '../../domain/types.js'
import { MemoryBackend } from '../../store/memory.js'

export const fixtureActor = (role: string, agent: string, sessionId = agent): Actor => ({
  sessionId,
  role,
  agent,
})
const SYSTEM = fixtureActor('user', 'fixture', 'fixture')

export interface BlockSpec {
  id: BlockId
  parent: BlockId
  title: string
  kind?: string
  status?: Status
  order?: number
  blockedOn?: Block['blockedOn']
  design?: Record<string, SectionValue>
  plan?: Record<string, SectionValue>
  digest?: Record<string, SectionValue>
}

export class FixtureBuilder {
  readonly backend = new MemoryBackend()
  readonly clock: Clock
  private orders = new Map<BlockId, number>()

  constructor(start = '2026-03-01T09:00:00.000Z') {
    this.clock = fixedClock(start, 60_000)
  }

  private tx(fn: Parameters<MemoryBackend['tx']>[1], by: Actor = SYSTEM) {
    return this.backend.tx({ by, command: 'fixture', major: true }, fn)
  }

  async project(name: string, rootId: BlockId, design?: Record<string, SectionValue>) {
    const now = this.clock.now()
    await this.tx(async (t) => {
      await t.putProject({
        id: 'prj_fixture',
        name,
        originFingerprint: 'fixture',
        rootBlockId: rootId,
        schemaSetVersion: 'default',
        epoch: 1,
        createdAt: now,
      })
      await t.putBlock(
        {
          id: rootId,
          parentId: null,
          title: name,
          kind: 'root',
          status: 'active',
          order: 0,
          version: 0,
          docVersions: { design: 0, plan: 0, digest: 0 },
          createdAt: now,
          updatedAt: now,
        },
        -1,
      )
    })
    if (design) await this.doc(rootId, 'design', design)
    return this
  }

  async block(spec: BlockSpec) {
    const now = this.clock.now()
    const order = spec.order ?? this.orders.get(spec.parent) ?? 0
    this.orders.set(spec.parent, order + 1)
    const status = spec.status ?? 'planned'
    await this.tx(async (t) => {
      await t.putBlock(
        {
          id: spec.id,
          parentId: spec.parent,
          title: spec.title,
          kind: spec.kind ?? 'component',
          status,
          ...(spec.blockedOn ? { blockedOn: spec.blockedOn } : {}),
          order,
          version: 0,
          docVersions: { design: 0, plan: 0, digest: 0 },
          ...(status === 'done' ? { doneAt: { ts: now } } : {}),
          createdAt: now,
          updatedAt: now,
        },
        -1,
      )
    })
    if (spec.design) await this.doc(spec.id, 'design', spec.design)
    if (spec.plan) await this.doc(spec.id, 'plan', spec.plan)
    if (spec.digest) await this.doc(spec.id, 'digest', spec.digest)
    return this
  }

  async doc(block: BlockId, type: DocType, sections: Record<string, SectionValue>) {
    const now = this.clock.now()
    await this.tx(async (t) => {
      const b = await t.getBlock(block)
      if (!b) throw new Error(`fixture: no block ${block}`)
      const version = b.docVersions[type] + 1
      await t.putDoc(
        { blockId: block, type, version, sections, updatedAt: now, by: SYSTEM },
        version - 1,
      )
      await t.putBlock(
        { ...b, docVersions: { ...b.docVersions, [type]: version }, version: b.version + 1 },
        b.version,
      )
    })
    return this
  }

  async edge(from: BlockId, to: BlockId) {
    await this.tx((t) => t.putEdge({ from, to, kind: 'depends_on' }))
    return this
  }

  async progress(
    block: BlockId,
    kind: ProgressKind,
    text: string,
    opts: { by?: Actor; refs?: string[]; id?: string } = {},
  ) {
    const ts = this.clock.now()
    const by = opts.by ?? fixtureActor('worker', 'worker-1')
    await this.tx(async (t) => {
      const n = (await t.readLog(block, 'progress')).length
      await t.appendLog(block, 'progress', {
        id: opts.id ?? `prg-${block}-${n + 1}`,
        blockId: block,
        ts,
        by,
        kind,
        text,
        refs: opts.refs ?? [],
      })
    }, by)
    return this
  }

  async step(block: BlockId, stepId: string, status: StepStatus, by?: Actor) {
    const ts = this.clock.now()
    const actor = by ?? fixtureActor('worker', 'worker-1')
    await this.tx(
      (t) => t.appendLog(block, 'steps', { blockId: block, stepId, status, ts, by: actor }),
      actor,
    )
    return this
  }

  async decision(
    block: BlockId,
    d: {
      id: string
      title: string
      decision: string
      rationale?: string
      standing?: Standing
      supersedes?: string
    },
  ) {
    const entry: Decision = {
      ...d,
      blockId: block,
      ts: this.clock.now(),
      by: fixtureActor('manager', 'manager'),
    }
    await this.tx((t) => t.appendLog(block, 'decisions', entry))
    return this
  }

  async thread(
    block: BlockId,
    th: { id: string; title: string; status?: ThreadStatus; gist?: string; entries?: string[] },
  ) {
    const now = this.clock.now()
    const by = fixtureActor('worker', 'worker-1')
    const thread: Thread = {
      id: th.id,
      blockId: block,
      title: th.title,
      status: th.status ?? 'open',
      ...(th.gist ? { gist: th.gist } : {}),
      entries: (th.entries ?? []).map((text) => ({ ts: now, by, text })),
      createdAt: now,
      updatedAt: now,
      by,
    }
    await this.tx((t) => t.putThread(thread).then(() => undefined))
    return this
  }
}
