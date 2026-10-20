// The Core service: every write and read agents can perform, host-agnostic.
// Gateways map onto these 1:1. See docs/ARCHITECTURE.md §5.
import type { Config } from '../config/schema.js'
import { type Clock, systemClock } from '../domain/clock.js'
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js'
import { opaqueId, slugId, token as mintToken } from '../domain/ids.js'
import { StatusMachine, type TransitionContext } from '../domain/status.js'
import {
  type Actor,
  type Block,
  type BlockId,
  type BlockedOn,
  type Decision,
  type DecisionView,
  deriveDecisionStatus,
  type Doc,
  type DocType,
  type Edge,
  type Focus,
  type Project,
  type ProgressEntry,
  type ProgressKind,
  type Proposal,
  type SectionValue,
  type Session,
  type Standing,
  type Status,
  type Step,
  type StepEvent,
  type StepStatus,
  type Thread,
} from '../domain/types.js'
import { type Notice, schemaFor, validateDoc } from '../schema/validate.js'
import type { StorageBackend, WriteOps } from '../store/backend.js'
import { countValue, estimatorTokenizer, type Tokenizer } from '../tokenizer.js'
import { authorize } from './authz.js'

export interface CoreDeps {
  config: Config
  backend: StorageBackend
  tokenizer?: Tokenizer
  clock?: Clock
}

export interface CommandResult<T = unknown> {
  result: T
  notices: Notice[]
  commit?: string
}

export interface NeedsConfirmation {
  needsConfirmation: true
  message: string
}

export interface BlockDetail {
  block: Block
  docs: Partial<Record<DocType, Doc>>
  steps: StepEvent[]
  progress: ProgressEntry[]
  decisions: DecisionView[]
  threads: Thread[]
  edges: { dependsOn: Edge[]; dependents: Edge[] }
}

type Handler = (by: Actor, args: Record<string, unknown>) => Promise<CommandResult<unknown>>

export class Core {
  readonly config: Config
  readonly backend: StorageBackend
  readonly tok: Tokenizer
  readonly clock: Clock
  readonly status: StatusMachine
  private readonly handlers = new Map<string, Handler>()

  constructor(deps: CoreDeps) {
    this.config = deps.config
    this.backend = deps.backend
    this.tok = deps.tokenizer ?? estimatorTokenizer
    this.clock = deps.clock ?? systemClock
    this.status = new StatusMachine(this.config.policies.status)
    this.registerHandlers()
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private isMinor(path: string): boolean {
    return this.config.policies.epoch.minor_paths.includes(path)
  }

  /** Run a command transaction: authz → fn → epoch bump (major) → audit. */
  private async run<T>(
    by: Actor,
    command: string,
    qualifier: string | undefined,
    major: boolean,
    target: string,
    fn: (t: WriteOps, notices: Notice[]) => Promise<T>,
    opts: { skipAuthz?: boolean; message?: string } = {},
  ): Promise<CommandResult<T>> {
    if (!opts.skipAuthz) authorize(this.config, by.role, command, qualifier)
    const notices: Notice[] = []
    const meta = { by, command, major, ...(opts.message ? { message: opts.message } : {}) }
    const { result, commit } = await this.backend.tx(meta, async (t) => {
      const r = await fn(t, notices)
      if (major) {
        const p = await t.getProject()
        if (p) await t.putProject({ ...p, epoch: p.epoch + 1 })
      }
      await t.appendAudit({
        ts: this.clock.now(),
        by,
        command: qualifier ? `${command}:${qualifier}` : command,
        target,
      })
      return r
    })
    return commit ? { result, notices, commit } : { result, notices }
  }

  private async mustBlock(
    t: { getBlock(id: BlockId): Promise<Block | null> },
    id: BlockId,
  ): Promise<Block> {
    const b = await t.getBlock(id)
    if (!b) throw new NotFoundError('block', id)
    return b
  }

  private checkVersion(b: Block, expected: number | undefined): number {
    if (expected !== undefined && expected !== b.version)
      throw new ConflictError(`block ${b.id}`, expected, b.version, b)
    return b.version
  }

  private async writeDoc(
    t: WriteOps,
    by: Actor,
    block: Block,
    type: DocType,
    sections: Record<string, SectionValue>,
    expectedVersion: number | undefined,
    notices: Notice[],
  ): Promise<Doc> {
    const schema = schemaFor(this.config, block.kind, type)
    const v = validateDoc(this.config, this.tok, schema, sections)
    notices.push(...v.notices)
    const cur = block.docVersions[type]
    if (expectedVersion !== undefined && expectedVersion !== cur) {
      const current = await t.getDoc(block.id, type)
      throw new ConflictError(`${type} of ${block.id}`, expectedVersion, cur, current)
    }
    const doc: Doc = {
      blockId: block.id,
      type,
      version: cur + 1,
      sections: v.sections,
      updatedAt: this.clock.now(),
      by,
    }
    await t.putDoc(doc, cur)
    const updated: Block = {
      ...block,
      docVersions: { ...block.docVersions, [type]: doc.version },
      updatedAt: doc.updatedAt,
      version: block.version + 1,
    }
    if (type === 'digest') delete updated.digestStale
    await t.putBlock(updated, block.version)
    Object.assign(block, updated)
    if (type === 'digest') delete block.digestStale // Object.assign cannot remove keys
    return doc
  }

  private async recordDecision(
    t: WriteOps,
    by: Actor,
    blockId: BlockId,
    d: {
      title: string
      decision: string
      rationale?: string
      standing?: Standing
      supersedes?: string
    },
  ): Promise<Decision> {
    const caps = this.config.logs.decision
    if (d.standing && !caps.standing.includes(d.standing))
      throw new ValidationError(`standing must be one of ${caps.standing.join(', ')}`)
    const soft = 1 + this.config.hafiz.tokenizer.soft_zone
    const n = countValue(this.tok, `${d.title} ${d.decision} ${d.rationale ?? ''}`)
    const cap = d.standing ? caps.standing_cap : caps.cap
    if (n > cap * soft)
      throw new ValidationError(
        `decision is ${n} tokens; cap is ${cap}. State the decision, not the discussion.`,
        { measured: n, cap },
      )
    if (d.supersedes) {
      const all = await t.readLog(blockId, 'decisions')
      if (!all.some((r) => r.entry.id === d.supersedes))
        throw new NotFoundError('decision', d.supersedes)
    }
    const entry: Decision = {
      id: opaqueId('dec'),
      blockId,
      ts: this.clock.now(),
      by,
      title: d.title,
      decision: d.decision,
      ...(d.rationale ? { rationale: d.rationale } : {}),
      ...(d.standing ? { standing: d.standing } : {}),
      ...(d.supersedes ? { supersedes: d.supersedes } : {}),
    }
    await t.appendLog(blockId, 'decisions', entry)
    return entry
  }

  // ───────────────────────────── project ─────────────────────────────

  async projectInit(
    by: Actor,
    args: {
      name: string
      originFingerprint: string
      rootDesign?: Record<string, SectionValue>
      id?: string
    },
  ): Promise<CommandResult<{ project: Project; root: Block }>> {
    return this.run(
      by,
      'project.init',
      undefined,
      true,
      'project',
      async (t, notices) => {
        if (await t.getProject()) throw new ValidationError('project already initialised')
        const now = this.clock.now()
        const root: Block = {
          id: slugId(args.name),
          parentId: null,
          title: args.name,
          kind: 'root',
          status: 'active',
          order: 0,
          version: 0,
          docVersions: { design: 0, plan: 0, digest: 0 },
          createdAt: now,
          updatedAt: now,
        }
        await t.putBlock(root, -1)
        const project: Project = {
          id: args.id ?? opaqueId('prj', 4),
          name: args.name,
          originFingerprint: args.originFingerprint,
          rootBlockId: root.id,
          schemaSetVersion: this.config.hafiz.schema_set,
          epoch: 0,
          createdAt: now,
        }
        await t.putProject(project)
        if (args.rootDesign) await this.writeDoc(t, by, root, 'design', args.rootDesign, 0, notices)
        return { project, root }
      },
      { skipAuthz: true },
    )
  }

  // ───────────────────────────── blocks ─────────────────────────────

  async blockCreate(
    by: Actor,
    args: {
      parent: BlockId
      title: string
      kind?: string
      order?: number
      design?: Record<string, SectionValue>
      plan?: Record<string, SectionValue>
    },
  ): Promise<CommandResult<Block>> {
    return this.run(by, 'block.create', undefined, true, args.title, async (t, notices) => {
      const parent = await this.mustBlock(t, args.parent)
      const kind = args.kind ?? this.config.kinds.default_kind
      const kindDef = this.config.kinds.kinds[kind]
      if (!kindDef)
        throw new ValidationError(
          `unknown kind '${kind}'. Known: ${Object.keys(this.config.kinds.kinds).join(', ')}`,
        )
      if (this.config.kinds.kinds[parent.kind]?.no_children)
        throw new ValidationError(`blocks of kind '${parent.kind}' cannot have children`)
      const siblings = (await t.listBlocks()).filter((b) => b.parentId === parent.id)
      const now = this.clock.now()
      const block: Block = {
        id: slugId(args.title),
        parentId: parent.id,
        title: args.title,
        kind,
        status: 'planned',
        order: args.order ?? siblings.length,
        version: 0,
        docVersions: { design: 0, plan: 0, digest: 0 },
        createdAt: now,
        updatedAt: now,
      }
      await t.putBlock(block, -1)
      if (args.design) await this.writeDoc(t, by, block, 'design', args.design, 0, notices)
      if (args.plan) await this.writeDoc(t, by, block, 'plan', args.plan, 0, notices)
      return block
    })
  }

  async blockUpdate(
    by: Actor,
    args: { id: BlockId; title?: string; kind?: string; order?: number; expectedVersion?: number },
  ): Promise<CommandResult<Block>> {
    return this.run(by, 'block.update', undefined, true, args.id, async (t) => {
      const b = await this.mustBlock(t, args.id)
      const v = this.checkVersion(b, args.expectedVersion)
      if (args.kind && !this.config.kinds.kinds[args.kind])
        throw new ValidationError(`unknown kind '${args.kind}'`)
      const nb: Block = {
        ...b,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        version: v + 1,
        updatedAt: this.clock.now(),
      }
      await t.putBlock(nb, v)
      return nb
    })
  }

  async blockMove(
    by: Actor,
    args: { id: BlockId; newParent: BlockId; expectedVersion?: number },
  ): Promise<CommandResult<Block>> {
    return this.run(by, 'block.move', undefined, true, args.id, async (t) => {
      const b = await this.mustBlock(t, args.id)
      if (!b.parentId) throw new ValidationError('the root block cannot be moved')
      const v = this.checkVersion(b, args.expectedVersion)
      const all = await t.listBlocks()
      const byId = new Map(all.map((x) => [x.id, x]))
      // reject moving under own descendant
      for (
        let p: Block | undefined = byId.get(args.newParent);
        p;
        p = p.parentId ? byId.get(p.parentId) : undefined
      )
        if (p.id === b.id) throw new ValidationError('cannot move a block under its own descendant')
      await this.mustBlock(t, args.newParent)
      const nb: Block = {
        ...b,
        parentId: args.newParent,
        version: v + 1,
        updatedAt: this.clock.now(),
      }
      await t.putBlock(nb, v)
      return nb
    })
  }

  async blockSetStatus(
    by: Actor,
    args: {
      id: BlockId
      status: Status
      digest?: Record<string, SectionValue>
      reason?: string
      blockedOn?: BlockedOn
      confirmed?: boolean
      expectedVersion?: number
    },
    opts: { skipAuthz?: boolean } = {},
  ): Promise<CommandResult<Block | NeedsConfirmation>> {
    return this.run(
      by,
      'block.set_status',
      args.status,
      true,
      args.id,
      async (t, notices) => {
        const b = await this.mustBlock(t, args.id)
        this.checkVersion(b, args.expectedVersion)
        const all = await t.listBlocks()
        const ctx: TransitionContext = {
          block: b,
          to: args.status,
          children: all.filter((x) => x.parentId === b.id),
          threads: await t.listThreads(b.id),
          digest: await t.getDoc(b.id, 'digest'),
          args: {
            digestProvided: !!args.digest,
            ...(args.reason !== undefined ? { reason: args.reason } : {}),
            ...(args.blockedOn ? { blockedOn: args.blockedOn } : {}),
            ...(args.confirmed !== undefined ? { confirmed: args.confirmed } : {}),
          },
          confirmDonePolicy: this.config.hafiz.confirm_done,
        }
        const outcome = this.status.check(ctx)
        if (!outcome.proceed)
          return {
            needsConfirmation: true,
            message: `Marking '${b.title}' (${b.id}) done requires confirmation. Ask the user, then call again with confirmed: true.`,
          } satisfies NeedsConfirmation
        if (args.digest) await this.writeDoc(t, by, b, 'digest', args.digest, undefined, notices)
        const now = this.clock.now()
        const reopen = b.status === 'done' && args.status === 'active'
        const nb: Block = { ...b, status: args.status, version: b.version + 1, updatedAt: now }
        delete nb.blockedOn
        if (args.status === 'blocked' && args.blockedOn) nb.blockedOn = args.blockedOn
        if (args.status === 'done') nb.doneAt = { ts: now }
        if (reopen) {
          nb.digestStale = true
          delete nb.doneAt
        }
        await t.putBlock(nb, b.version)
        if (args.reason)
          await this.recordDecision(t, by, b.id, {
            title: `${reopen ? 'Reopened' : args.status === 'dropped' ? 'Dropped' : 'Status → ' + args.status}: ${b.title}`,
            decision: args.reason,
          })
        if (
          args.status === 'active' &&
          nb.parentId &&
          this.config.policies.status.activate_parent_on_child_active
        ) {
          const p = all.find((x) => x.id === nb.parentId)
          if (p && p.status === 'planned')
            await t.putBlock(
              { ...p, status: 'active', version: p.version + 1, updatedAt: now },
              p.version,
            )
        }
        if (args.status === 'done' && this.config.hafiz.confirm_done === 'auto') {
          await t.putProposal({
            id: opaqueId('prop'),
            kind: 'status',
            source: 'auto_done',
            blockId: b.id,
            payload: { command: 'block.set_status', args: { id: b.id, status: 'done' } },
            note: `'${b.title}' was marked done by ${by.role}; review the digest.`,
            status: 'pending',
            createdAt: now,
          })
        }
        return nb
      },
      opts,
    )
  }

  /** Worker path: write the digest, then either apply `done` (auto) or enqueue it for the manager. */
  async blockRequestDone(
    by: Actor,
    args: { id: BlockId; digest: Record<string, SectionValue> },
  ): Promise<CommandResult<Block | NeedsConfirmation | { queued: true; proposal: Proposal }>> {
    authorize(this.config, by.role, 'block.request_done')
    if (this.config.hafiz.confirm_done === 'auto')
      return this.blockSetStatus(
        by,
        { id: args.id, status: 'done', digest: args.digest },
        { skipAuthz: true },
      )
    return this.run(
      by,
      'block.request_done',
      undefined,
      false,
      args.id,
      async (t, notices) => {
        const b = await this.mustBlock(t, args.id)
        await this.writeDoc(t, by, b, 'digest', args.digest, undefined, notices)
        const proposal: Proposal = {
          id: opaqueId('prop'),
          kind: 'status',
          source: 'auto_done',
          blockId: b.id,
          payload: {
            command: 'block.set_status',
            args: { id: b.id, status: 'done', confirmed: true },
          },
          note: `${by.role} requests '${b.title}' be marked done; digest written.`,
          status: 'pending',
          createdAt: this.clock.now(),
        }
        await t.putProposal(proposal)
        return { queued: true as const, proposal }
      },
      { skipAuthz: true },
    )
  }

  // ───────────────────────────── edges ─────────────────────────────

  async edgeAdd(
    by: Actor,
    args: { from: BlockId; to: BlockId; kind?: string },
  ): Promise<CommandResult<Edge>> {
    return this.run(by, 'edge.add', undefined, true, `${args.from}→${args.to}`, async (t) => {
      if (args.from === args.to) throw new ValidationError('a block cannot depend on itself')
      await this.mustBlock(t, args.from)
      await this.mustBlock(t, args.to)
      const e: Edge = { from: args.from, to: args.to, kind: args.kind ?? 'depends_on' }
      await t.putEdge(e)
      return e
    })
  }

  async edgeRemove(
    by: Actor,
    args: { from: BlockId; to: BlockId; kind?: string },
  ): Promise<CommandResult<void>> {
    return this.run(by, 'edge.remove', undefined, true, `${args.from}→${args.to}`, async (t) => {
      await t.deleteEdge({ from: args.from, to: args.to, kind: args.kind ?? 'depends_on' })
    })
  }

  // ───────────────────────────── docs ─────────────────────────────

  async docWrite(
    by: Actor,
    args: {
      block: BlockId
      type: DocType
      sections: Record<string, SectionValue>
      expectedVersion?: number
    },
  ): Promise<CommandResult<Doc>> {
    return this.run(
      by,
      'doc.write',
      args.type,
      !this.isMinor(args.type),
      `${args.block}/${args.type}`,
      async (t, notices) => {
        const b = await this.mustBlock(t, args.block)
        return this.writeDoc(t, by, b, args.type, args.sections, args.expectedVersion, notices)
      },
    )
  }

  async docPatch(
    by: Actor,
    args: {
      block: BlockId
      type: DocType
      sections: Record<string, SectionValue>
      expectedVersion?: number
    },
  ): Promise<CommandResult<Doc>> {
    return this.run(
      by,
      'doc.patch',
      args.type,
      !this.isMinor(args.type),
      `${args.block}/${args.type}`,
      async (t, notices) => {
        const b = await this.mustBlock(t, args.block)
        const cur = await t.getDoc(b.id, args.type)
        const merged = { ...(cur?.sections ?? {}), ...args.sections }
        return this.writeDoc(t, by, b, args.type, merged, args.expectedVersion, notices)
      },
    )
  }

  // ───────────────────────────── logs ─────────────────────────────

  async stepSet(
    by: Actor,
    args: { block: BlockId; stepId: string; status: StepStatus },
  ): Promise<CommandResult<StepEvent>> {
    return this.run(
      by,
      'step.set',
      undefined,
      !this.isMinor('steps'),
      `${args.block}#${args.stepId}`,
      async (t) => {
        const b = await this.mustBlock(t, args.block)
        if (!this.config.logs.step.statuses.includes(args.status))
          throw new ValidationError(
            `step status must be one of ${this.config.logs.step.statuses.join(', ')}`,
          )
        const plan = await t.getDoc(b.id, 'plan')
        const steps = (plan?.sections.steps ?? []) as Step[]
        if (!steps.some((s) => s.id === args.stepId))
          throw new NotFoundError(
            'step',
            `${args.stepId} (known: ${steps.map((s) => s.id).join(', ') || 'none — write a plan first'})`,
          )
        const ev: StepEvent = {
          blockId: b.id,
          stepId: args.stepId,
          status: args.status,
          ts: this.clock.now(),
          by,
        }
        await t.appendLog(b.id, 'steps', ev)
        return ev
      },
    )
  }

  async progressAppend(
    by: Actor,
    args: { block: BlockId; kind: ProgressKind; text: string; refs?: string[] },
  ): Promise<CommandResult<ProgressEntry>> {
    return this.run(
      by,
      'progress.append',
      undefined,
      !this.isMinor('progress'),
      args.block,
      async (t) => {
        const b = await this.mustBlock(t, args.block)
        const cfg = this.config.logs.progress
        if (!cfg.kinds.includes(args.kind))
          throw new ValidationError(`progress kind must be one of ${cfg.kinds.join(', ')}`)
        const n = this.tok.count(args.text)
        const cap =
          args.kind === 'report' ? this.config.compliance.report_capture.cap_tokens : cfg.cap
        if (n > cap * (1 + this.config.hafiz.tokenizer.soft_zone))
          throw new ValidationError(
            `progress entry is ${n} tokens; cap is ${cap}. One finding per entry.`,
            { measured: n, cap },
          )
        const e: ProgressEntry = {
          id: opaqueId('prg'),
          blockId: b.id,
          ts: this.clock.now(),
          by,
          kind: args.kind,
          text: args.text,
          refs: args.refs ?? [],
        }
        await t.appendLog(b.id, 'progress', e)
        return e
      },
    )
  }

  async decisionRecord(
    by: Actor,
    args: {
      block: BlockId
      title: string
      decision: string
      rationale?: string
      standing?: Standing
      supersedes?: string
    },
  ): Promise<CommandResult<Decision>> {
    return this.run(by, 'decision.record', undefined, true, args.block, async (t) => {
      await this.mustBlock(t, args.block)
      return this.recordDecision(t, by, args.block, args)
    })
  }

  // ───────────────────────────── threads ─────────────────────────────

  async threadOpen(
    by: Actor,
    args: { block: BlockId; title: string; text?: string },
  ): Promise<CommandResult<Thread>> {
    return this.run(by, 'thread.open', undefined, false, args.block, async (t) => {
      const b = await this.mustBlock(t, args.block)
      const now = this.clock.now()
      const th: Thread = {
        id: opaqueId('thr'),
        blockId: b.id,
        title: args.title,
        status: 'open',
        entries: args.text ? [{ ts: now, by, text: args.text }] : [],
        createdAt: now,
        updatedAt: now,
        by,
      }
      await t.putThread(th)
      return th
    })
  }

  private async threadTransition(
    by: Actor,
    command: string,
    id: string,
    to: Thread['status'],
    fn?: (th: Thread) => void,
  ): Promise<CommandResult<Thread>> {
    return this.run(by, command, undefined, false, id, async (t) => {
      const th = await t.getThread(id)
      if (!th) throw new NotFoundError('thread', id)
      fn?.(th)
      th.status = to
      th.updatedAt = this.clock.now()
      await t.putThread(th)
      return th
    })
  }

  threadPark(by: Actor, args: { id: string; gist: string }) {
    const cap = this.config.logs.thread.gist_cap
    return this.threadTransition(by, 'thread.park', args.id, 'parked', (th) => {
      if (!args.gist?.trim())
        throw new ValidationError(
          'a gist is required to park a thread: what was being discussed and where it stands.',
        )
      const n = this.tok.count(args.gist)
      if (n > cap * (1 + this.config.hafiz.tokenizer.soft_zone))
        throw new ValidationError(`gist is ${n} tokens; cap is ${cap}.`)
      th.gist = args.gist
    })
  }
  threadResume(by: Actor, args: { id: string }) {
    return this.threadTransition(by, 'thread.resume', args.id, 'open')
  }
  threadResolve(by: Actor, args: { id: string; outcome?: string }) {
    return this.threadTransition(by, 'thread.resolve', args.id, 'resolved', (th) => {
      if (args.outcome) th.entries.push({ ts: this.clock.now(), by, text: args.outcome })
    })
  }
  threadAppend(by: Actor, args: { id: string; text: string }) {
    const cap = this.config.logs.thread.entry_cap
    return this.run(by, 'thread.append', undefined, false, args.id, async (t) => {
      const th = await t.getThread(args.id)
      if (!th) throw new NotFoundError('thread', args.id)
      if (this.tok.count(args.text) > cap * (1 + this.config.hafiz.tokenizer.soft_zone))
        throw new ValidationError(`entry exceeds ${cap} tokens`)
      th.entries.push({ ts: this.clock.now(), by, text: args.text })
      th.updatedAt = this.clock.now()
      await t.putThread(th)
      return th
    })
  }

  // ───────────────────────────── sessions & focus ─────────────────────────────

  /** Open (or re-attach to) a session. Not role-gated: gateways call it before any role exists. */
  async sessionOpen(args: {
    id: string
    host: string
    role: string
    agent?: string
    parentSessionId?: string
    spawnedBlock?: BlockId
  }): Promise<Session> {
    const existing = await this.backend.read.getSession(args.id)
    const role = this.config.roles.roles[args.role]
    if (!role) throw new ValidationError(`unknown role '${args.role}'`)
    const by: Actor = {
      sessionId: args.id,
      role: args.role,
      ...(args.agent ? { agent: args.agent } : {}),
    }
    const { result } = await this.run(
      by,
      'session.open',
      undefined,
      false,
      args.id,
      async (t) => {
        const now = this.clock.now()
        if (existing) {
          const s: Session = { ...existing, updatedAt: now }
          delete s.endedAt
          await t.putSession(s)
          return s
        }
        const focus = await this.computeFocus(t, role.focus_policy, args.spawnedBlock)
        const s: Session = {
          id: args.id,
          projectId: (await t.getProject())?.id ?? '',
          host: args.host,
          role: args.role,
          ...(args.agent ? { agent: args.agent } : {}),
          token: mintToken(),
          ...(args.parentSessionId ? { parentSessionId: args.parentSessionId } : {}),
          focus,
          counters: {},
          createdAt: now,
          updatedAt: now,
        }
        await t.putSession(s)
        return s
      },
      { skipAuthz: true },
    )
    return result
  }

  private async computeFocus(t: WriteOps, policy: string, spawned?: BlockId): Promise<Focus> {
    if (policy === 'spawned_block' && spawned) return { blocks: [spawned], computed: true }
    if (policy === 'all_active') {
      const active = (await t.listBlocks()).filter(
        (b) => b.status === 'active' && b.parentId !== null,
      )
      return { blocks: active.map((b) => b.id), computed: true }
    }
    return { blocks: [], computed: true }
  }

  async sessionEnd(sessionId: string): Promise<void> {
    const s = await this.backend.read.getSession(sessionId)
    if (!s) return
    await this.run(
      { sessionId, role: s.role },
      'session.end',
      undefined,
      false,
      sessionId,
      async (t) => {
        await t.putSession({ ...s, endedAt: this.clock.now(), updatedAt: this.clock.now() })
      },
      { skipAuthz: true },
    )
  }

  async countersAdd(sessionId: string, delta: Record<string, number>): Promise<Session | null> {
    const s = await this.backend.read.getSession(sessionId)
    if (!s) return null
    const counters = { ...s.counters }
    for (const [k, v] of Object.entries(delta)) counters[k] = (counters[k] ?? 0) + v
    const { result } = await this.run(
      { sessionId, role: s.role },
      'session.counters',
      undefined,
      false,
      sessionId,
      async (t) => {
        const ns = { ...s, counters, updatedAt: this.clock.now() }
        await t.putSession(ns)
        return ns
      },
      { skipAuthz: true },
    )
    return result
  }

  async focusSet(
    by: Actor,
    args: { blocks: BlockId[]; order?: BlockId[] },
  ): Promise<CommandResult<Session>> {
    return this.run(by, 'focus.set', undefined, false, by.sessionId, async (t) => {
      const s = await t.getSession(by.sessionId)
      if (!s) throw new NotFoundError('session', by.sessionId)
      for (const id of args.blocks) await this.mustBlock(t, id)
      const ns: Session = {
        ...s,
        focus: {
          blocks: args.blocks,
          ...(args.order ? { order: args.order } : {}),
          computed: false,
        },
        updatedAt: this.clock.now(),
      }
      await t.putSession(ns)
      return ns
    })
  }

  /** Re-evaluate a computed focus (e.g. a new block became active) without touching explicit ones. */
  async refreshComputedFocus(sessionId: string): Promise<Session | null> {
    const s = await this.backend.read.getSession(sessionId)
    if (!s || !s.focus.computed) return s
    const role = this.config.roles.roles[s.role]
    if (!role || role.focus_policy !== 'all_active') return s
    const { result } = await this.run(
      { sessionId, role: s.role },
      'session.focus_refresh',
      undefined,
      false,
      sessionId,
      async (t) => {
        const ns = {
          ...s,
          focus: await this.computeFocus(t, 'all_active'),
          updatedAt: this.clock.now(),
        }
        await t.putSession(ns)
        return ns
      },
      { skipAuthz: true },
    )
    return result
  }

  // ───────────────────────────── proposals ─────────────────────────────

  async proposalResolve(
    by: Actor,
    args: { id: string; accept: boolean },
  ): Promise<CommandResult<Proposal>> {
    authorize(this.config, by.role, args.accept ? 'proposal.accept' : 'proposal.reject')
    const p = (await this.backend.read.listProposals()).find((x) => x.id === args.id)
    if (!p) throw new NotFoundError('proposal', args.id)
    if (p.status !== 'pending') throw new ValidationError(`proposal already ${p.status}`)
    // Accepting a not-yet-applied proposal performs its command as the accepting actor.
    if (args.accept && p.source !== 'auto_done') {
      const h = this.handlers.get(p.payload.command)
      if (!h) throw new ValidationError(`proposal command '${p.payload.command}' is not executable`)
      await h(by, p.payload.args)
    }
    return this.run(
      by,
      args.accept ? 'proposal.accept' : 'proposal.reject',
      undefined,
      false,
      p.id,
      async (t) => {
        const np: Proposal = {
          ...p,
          status: args.accept ? 'accepted' : 'rejected',
          resolvedAt: this.clock.now(),
          resolvedBy: by,
        }
        await t.putProposal(np)
        return np
      },
      { skipAuthz: true },
    )
  }

  async proposalAdd(
    p: Omit<Proposal, 'id' | 'status' | 'createdAt'>,
    by: Actor,
  ): Promise<Proposal> {
    const { result } = await this.run(
      by,
      'proposal.add',
      undefined,
      false,
      p.blockId ?? 'project',
      async (t) => {
        const np: Proposal = {
          ...p,
          id: opaqueId('prop'),
          status: 'pending',
          createdAt: this.clock.now(),
        }
        await t.putProposal(np)
        return np
      },
      { skipAuthz: true },
    )
    return result
  }

  // ───────────────────────────── reads ─────────────────────────────

  async treeList(
    by: Actor,
  ): Promise<
    Array<
      Pick<Block, 'id' | 'parentId' | 'title' | 'kind' | 'status' | 'order'> & { depth: number }
    >
  > {
    authorize(this.config, by.role, 'tree.list')
    return this.treeListRaw()
  }

  async treeListRaw() {
    const all = await this.backend.read.listBlocks()
    const byParent = new Map<BlockId | null, Block[]>()
    for (const b of all) byParent.set(b.parentId, [...(byParent.get(b.parentId) ?? []), b])
    const out: Array<
      Pick<Block, 'id' | 'parentId' | 'title' | 'kind' | 'status' | 'order'> & { depth: number }
    > = []
    const walk = (parent: BlockId | null, depth: number) => {
      for (const b of (byParent.get(parent) ?? []).sort(
        (a, c) => a.order - c.order || a.createdAt.localeCompare(c.createdAt),
      )) {
        out.push({
          id: b.id,
          parentId: b.parentId,
          title: b.title,
          kind: b.kind,
          status: b.status,
          order: b.order,
          depth,
        })
        walk(b.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  async blockDetail(by: Actor, id: BlockId): Promise<BlockDetail> {
    authorize(this.config, by.role, 'block.read')
    return this.blockDetailRaw(id)
  }

  async blockDetailRaw(id: BlockId): Promise<BlockDetail> {
    const r = this.backend.read
    const block = await this.mustBlock(r, id)
    const docs: Partial<Record<DocType, Doc>> = {}
    for (const type of ['design', 'plan', 'digest'] as const) {
      const d = await r.getDoc(id, type)
      if (d) docs[type] = d
    }
    const edges = await r.listEdges()
    return {
      block,
      docs,
      steps: (await r.readLog(id, 'steps')).map((x) => x.entry),
      progress: (await r.readLog(id, 'progress')).map((x) => x.entry),
      decisions: deriveDecisionStatus((await r.readLog(id, 'decisions')).map((x) => x.entry)),
      threads: await r.listThreads(id),
      edges: {
        dependsOn: edges.filter((e) => e.from === id),
        dependents: edges.filter((e) => e.to === id),
      },
    }
  }

  // ───────────────────────────── dispatch ─────────────────────────────

  private registerHandlers() {
    const reg = <A extends Record<string, unknown>>(
      name: string,
      fn: (by: Actor, a: A) => Promise<CommandResult<unknown>>,
    ) => this.handlers.set(name, fn as Handler)
    reg('block.create', (b, a) => this.blockCreate(b, a as never))
    reg('block.update', (b, a) => this.blockUpdate(b, a as never))
    reg('block.move', (b, a) => this.blockMove(b, a as never))
    reg('block.set_status', (b, a) => this.blockSetStatus(b, a as never))
    reg('block.request_done', (b, a) => this.blockRequestDone(b, a as never))
    reg('edge.add', (b, a) => this.edgeAdd(b, a as never))
    reg('edge.remove', (b, a) => this.edgeRemove(b, a as never))
    reg('doc.write', (b, a) => this.docWrite(b, a as never))
    reg('doc.patch', (b, a) => this.docPatch(b, a as never))
    reg('step.set', (b, a) => this.stepSet(b, a as never))
    reg('progress.append', (b, a) => this.progressAppend(b, a as never))
    reg('decision.record', (b, a) => this.decisionRecord(b, a as never))
    reg('thread.open', (b, a) => this.threadOpen(b, a as never))
    reg('thread.park', (b, a) => this.threadPark(b, a as never))
    reg('thread.resume', (b, a) => this.threadResume(b, a as never))
    reg('thread.resolve', (b, a) => this.threadResolve(b, a as never))
    reg('thread.append', (b, a) => this.threadAppend(b, a as never))
    reg('focus.set', (b, a) => this.focusSet(b, a as never))
  }

  /** Generic entry point used by gateways and by proposal acceptance. */
  async dispatch(
    by: Actor,
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandResult<unknown>> {
    const h = this.handlers.get(command)
    if (!h) throw new ValidationError(`unknown command '${command}'`)
    return h(by, args)
  }
}
