// The Core service: every write and read agents can perform, host-agnostic.
// Gateways map onto these 1:1. See docs/ARCHITECTURE.md §5.

import { type CondenseInput, Condenser, type CondenseTurn } from '../condense/condenser.js'
import { Drafters } from '../condense/drafter.js'
import type { Config } from '../config/schema.js'
import { type Clock, systemClock } from '../domain/clock.js'
import { ConflictError, NotFoundError, ValidationError } from '../domain/errors.js'
import { token as mintToken, opaqueId, slugId } from '../domain/ids.js'
import { StatusMachine, type TransitionContext } from '../domain/status.js'
import {
  type Actor,
  type Block,
  type BlockedOn,
  type BlockId,
  type ComplianceState,
  type CondenseCursor,
  type Decision,
  type DecisionView,
  DOC_TYPES,
  type Doc,
  type DocType,
  deriveDecisionStatus,
  type Edge,
  type Focus,
  type ProgressEntry,
  type ProgressKind,
  type Project,
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
import { createProvider, NoneProvider, providerEnabled, withRequestMeta } from '../llm/providers.js'
import type { LLMProvider, LLMRelay, LLMUsage } from '../llm/types.js'
import { gitHead } from '../project/resolve.js'
import { type Notice, schemaFor, validateDoc } from '../schema/validate.js'
import {
  type ComplianceCheck,
  ComplianceEngine,
  type ComplianceWhen,
  complianceProposals,
  initialState,
  type ProposalDraft,
  renderMessage,
} from '../session/compliance.js'
import { COST } from '../session/cost.js'
import type { StorageBackend, WriteOps } from '../store/backend.js'
import { countValue, estimatorTokenizer, type Tokenizer } from '../tokenizer.js'
import { computeDelta, type DeltaResult, deltaScope } from '../view/delta.js'
import {
  buildView,
  type Explanation,
  explain,
  type ManifestEntry,
  readBlock,
  type ViewOptions,
} from '../view/engine.js'
import { parseSelector, resolveView } from '../view/policy.js'
import { loadSnapshot, type Snapshot } from '../view/snapshot.js'
import { authorize } from './authz.js'

export interface CoreDeps {
  config: Config
  backend: StorageBackend
  tokenizer?: Tokenizer
  clock?: Clock
  /** Replace the providers built from `hafiz.yaml llm.*` (tests inject fakes). */
  llm?: { condenser?: LLMProvider; drafter?: LLMProvider }
  /** Runs relayed providers (`llm.*.provider: kilo`) in the host process that registered. */
  relay?: LLMRelay
  /** Environment for provider API keys (default: process.env). */
  env?: NodeJS.ProcessEnv
  /** The project's repo; `done` records its HEAD so `hafiz doctor` can detect drift. */
  repoDir?: string
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

/** A decision as the TUI lists it. */
export interface DecisionBrief {
  id: string
  blockId: BlockId
  title: string
  decision: string
  ts: string
  standing?: Standing
}

export interface TreeSummaryNode {
  id: BlockId
  parentId: BlockId | null
  title: string
  kind: string
  status: Status
  order: number
  depth: number
  blockedOn?: BlockedOn
  /** Plan steps done (or skipped) of total; absent without a plan. */
  steps?: { done: number; total: number }
  docs: Record<DocType, number>
  /** Open and parked threads. */
  threads: Array<{ id: string; title: string; status: Thread['status'] }>
  /** Active decisions on the block. */
  decisions: number
  /** The latest active decisions, newest first. */
  recentDecisions: DecisionBrief[]
}

export interface TreeSummary {
  project: { id: string; name: string; epoch: number } | null
  /** Depth-first tree order. */
  nodes: TreeSummaryNode[]
  /** Active standing decisions (what the view floor carries), tree order. */
  standing: DecisionBrief[]
}

export interface ContextOptions {
  /** Model key into `hafiz.yaml windows`. */
  model?: string
  /** Explicit view budget in tokens. */
  budgetTokens?: number
  /** Render for an ad-hoc session that is never persisted (CLI preview). */
  adhoc?: { role: string; focus?: Focus }
}

export interface ContextView {
  text: string
  hash: string
  floorText: string
  manifest: ManifestEntry[]
  notices: Notice[]
  budget: number
  tokens: number
  /** True when the hash differs from the session's previous view (always true for ad-hoc). */
  changed: boolean
}

/** Focus from a role's focus policy, computed over the current blocks. */
export function focusFromPolicy(
  blocks: readonly Block[],
  policy: string,
  spawned?: BlockId,
): Focus {
  if (policy === 'spawned_block' && spawned) return { blocks: [spawned], computed: true }
  if (policy === 'all_active') {
    const active = [...blocks]
      .filter((b) => b.status === 'active' && b.parentId !== null)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return { blocks: active.map((b) => b.id), computed: true }
  }
  return { blocks: [], computed: true }
}

function bump(c: Record<string, number>, delta: Record<string, number>): Record<string, number> {
  const out = { ...c }
  for (const [k, v] of Object.entries(delta)) out[k] = (out[k] ?? 0) + v
  return out
}

type Handler = (by: Actor, args: Record<string, unknown>) => Promise<CommandResult<unknown>>

export class Core {
  readonly config: Config
  readonly backend: StorageBackend
  readonly tok: Tokenizer
  readonly clock: Clock
  readonly status: StatusMachine
  private readonly handlers = new Map<string, Handler>()
  readonly compliance: ComplianceEngine
  readonly condenserProvider: LLMProvider
  readonly drafterProvider: LLMProvider
  private readonly repoDir: string | undefined

  constructor(deps: CoreDeps) {
    this.config = deps.config
    this.repoDir = deps.repoDir
    this.backend = deps.backend
    this.tok = deps.tokenizer ?? estimatorTokenizer
    this.clock = deps.clock ?? systemClock
    this.status = new StatusMachine(this.config.policies.status)
    this.compliance = new ComplianceEngine(this.config.compliance.checks)
    const io = { env: deps.env ?? process.env, ...(deps.relay ? { relay: deps.relay } : {}) }
    const llm = this.config.hafiz.llm
    this.condenserProvider = deps.llm?.condenser ?? createProvider(llm.condenser, io)
    this.drafterProvider =
      deps.llm?.drafter ??
      (llm.drafters.enabled ? createProvider(llm.drafters, io) : new NoneProvider())
    this.registerHandlers()
  }

  /** True when a condenser provider is configured (otherwise the host keeps its own compaction). */
  get condenserEnabled(): boolean {
    return providerEnabled({ provider: this.condenserProvider.name })
  }

  get draftersEnabled(): boolean {
    return this.config.hafiz.llm.drafters.enabled && this.drafterProvider.name !== 'none'
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
    const dirty = await this.backend.dirty()
    if (dirty.length)
      notices.push({
        level: 'warn',
        text: `store files were edited outside Hafiz: ${dirty.join(', ')}; they will be committed with this write`,
      })
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
    if (type === 'design' && block.parentId === null) await this.finishOnboarding(t, by, block)
    return doc
  }

  /** The first root design of a brownfield project completes its onboarding. */
  private async finishOnboarding(t: WriteOps, by: Actor, root: Block): Promise<void> {
    const project = await t.getProject()
    if (project?.onboarding !== 'pending') return
    const { onboarding: _done, ...rest } = project
    await t.putProject(rest)
    await this.recordDecision(t, by, root.id, {
      title: 'Onboarded existing codebase',
      decision: 'The root design describes the codebase as it was when Hafiz started tracking it.',
    })
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
      /** The repo already has code: the designer describes it before new work (onboarding). */
      onboarding?: boolean
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
          schemaSetVersion: this.config.hafiz.schema_version,
          epoch: 0,
          ...(args.onboarding ? { onboarding: 'pending' as const } : {}),
          createdAt: now,
        }
        await t.putProject(project)
        if (args.rootDesign) await this.writeDoc(t, by, root, 'design', args.rootDesign, 0, notices)
        return { project, root }
      },
      { skipAuthz: true },
    )
  }

  /** Apply a planned schema migration atomically: rewrite the docs, then re-pin the project. */
  async schemaMigrate(
    by: Actor,
    args: {
      to: string
      docs: Array<{ block: BlockId; type: DocType; sections: Record<string, SectionValue> }>
    },
  ): Promise<CommandResult<{ migrated: number }>> {
    return this.run(
      by,
      'schema.migrate',
      undefined,
      true,
      'project',
      async (t, notices) => {
        const project = await t.getProject()
        if (!project) throw new ValidationError('project not initialised')
        for (const d of args.docs) {
          const b = await this.mustBlock(t, d.block)
          await this.writeDoc(t, by, b, d.type, d.sections, undefined, notices)
        }
        await t.putProject({ ...project, schemaSetVersion: args.to })
        return { migrated: args.docs.length }
      },
      { skipAuthz: true, message: `hafiz: migrate schema set to version ${args.to}` },
    )
  }

  /** Every stored doc (current versions), for migration planning and doctor checks. */
  async allDocs(): Promise<{ blocks: Block[]; docs: Doc[] }> {
    const blocks = await this.backend.read.listBlocks()
    const docs: Doc[] = []
    for (const b of blocks)
      for (const type of DOC_TYPES) {
        const d = await this.backend.read.getDoc(b.id, type)
        if (d) docs.push(d)
      }
    return { blocks, docs }
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
        if (args.status === 'done') {
          // HEAD of the caller's own working tree (a worktree, when it runs in one); the
          // daemon's startup checkout only when the session did not say where it runs.
          const dir = (await t.getSession(by.sessionId))?.worktree ?? this.repoDir
          const commit = dir ? gitHead(dir) : undefined
          nb.doneAt = commit ? { ts: now, commit } : { ts: now }
        }
        if (reopen) {
          nb.digestStale = true
          delete nb.doneAt
        }
        await t.putBlock(nb, b.version)
        if (args.reason)
          await this.recordDecision(t, by, b.id, {
            title: `${reopen ? 'Reopened' : args.status === 'dropped' ? 'Dropped' : `Status → ${args.status}`}: ${b.title}`,
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
    return this.logProgress(by, 'progress.append', args.kind, args, false)
  }

  /**
   * Report capture: a host plugin stores a finished subagent's final message as a `report`
   * entry on its block. A system action, not an agent tool call: no role allowlist applies, but
   * the entry is attributed to the child session and audited as `report.capture`. Not a
   * registered command, so `dispatch` (and every tool catalogue) cannot reach it.
   */
  async reportCapture(
    by: Actor,
    args: { block: BlockId; text: string },
  ): Promise<CommandResult<ProgressEntry>> {
    return this.logProgress(by, 'report.capture', undefined, { ...args, kind: 'report' }, true)
  }

  private async logProgress(
    by: Actor,
    command: string,
    qualifier: string | undefined,
    args: { block: BlockId; kind: ProgressKind; text: string; refs?: string[] },
    skipAuthz: boolean,
  ): Promise<CommandResult<ProgressEntry>> {
    return this.run(
      by,
      command,
      qualifier,
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
      { skipAuthz },
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
        throw new ValidationError(`gist is ${n} tokens; cap is ${cap}.`, { measured: n, cap })
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
      const n = this.tok.count(args.text)
      if (n > cap * (1 + this.config.hafiz.tokenizer.soft_zone))
        throw new ValidationError(`entry exceeds ${cap} tokens`, { measured: n, cap })
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
    /** Working tree the session runs in (git top level of its cwd). */
    worktree?: string
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
          const s: Session = { ...((await t.getSession(args.id)) ?? existing), updatedAt: now }
          delete s.endedAt
          if (args.worktree) s.worktree = args.worktree
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
          ...(args.worktree ? { worktree: args.worktree } : {}),
          focus,
          counters: {},
          compliance: initialState(await t.currentSeq()),
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
    return focusFromPolicy(await t.listBlocks(), policy, spawned)
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
        const cur = (await t.getSession(sessionId)) ?? s
        await t.putSession({ ...cur, endedAt: this.clock.now(), updatedAt: this.clock.now() })
      },
      { skipAuthz: true },
    )
  }

  async countersAdd(sessionId: string, delta: Record<string, number>): Promise<Session | null> {
    const s = await this.backend.read.getSession(sessionId)
    if (!s) return null
    const { result } = await this.run(
      { sessionId, role: s.role },
      'session.counters',
      undefined,
      false,
      sessionId,
      async (t) => {
        // re-read inside the transaction: condensation and compliance write the session too
        const cur = (await t.getSession(sessionId)) ?? s
        const ns = { ...cur, counters: bump(cur.counters, delta), updatedAt: this.clock.now() }
        await t.putSession(ns)
        return ns
      },
      { skipAuthz: true },
    )
    return result
  }

  // ───────────────────────────── compliance ─────────────────────────────

  /** Bring the session's compliance bookkeeping up to date from the store (incremental). */
  private async complianceState(s: Session): Promise<{
    state: ComplianceState
    openThreads: Thread[]
  }> {
    const r = this.backend.read
    const state: ComplianceState = {
      ...(s.compliance ?? initialState()),
      active: [...(s.compliance?.active ?? [])],
    }
    const turns = s.counters.turns ?? 0
    for (;;) {
      const rows = await r.readSince(state.seq, 500)
      for (const row of rows) {
        if (row.log === 'progress' && (row.entry as ProgressEntry).by.sessionId === s.id)
          state.progress++
        state.seq = Math.max(state.seq, row.seq)
      }
      if (rows.length < 500) break
    }
    const mine = (await r.listThreads()).filter((t) => t.by.sessionId === s.id)
    if (state.progress > (s.compliance?.progress ?? 0)) state.progressTurn = turns
    if (mine.length > state.threads) state.userTurnsAtThread = s.counters.user_turns ?? 0
    state.threads = mine.length
    return { state, openThreads: mine.filter((t) => t.status === 'open') }
  }

  /**
   * Evaluate the compliance checks of one hook for a session. Returns the notices to show the
   * session and the proposals queued for review. Each check fires once per false→true change.
   */
  async complianceRun(
    sessionId: string,
    when: ComplianceWhen,
  ): Promise<{ notices: Notice[]; proposals: Proposal[] }> {
    const none = { notices: [] as Notice[], proposals: [] as Proposal[] }
    const s = await this.backend.read.getSession(sessionId)
    if (!s || !this.compliance.forHook(when).length) return none
    const { state, openThreads } = await this.complianceState(s)
    const focused = s.focus.blocks.length > 0
    const metrics: Record<string, number> = {
      ...s.counters,
      progress: state.progress,
      turns_since_progress: focused ? (s.counters.turns ?? 0) - state.progressTurn : 0,
      threads_opened_open: openThreads.length,
      user_turns_on_focus_without_thread: focused
        ? (s.counters.user_turns ?? 0) - state.userTurnsAtThread
        : 0,
    }
    const { fired, active } = this.compliance.evaluate(when, metrics, state.active)
    state.active = active
    const changed = JSON.stringify(state) !== JSON.stringify(s.compliance)
    if (changed)
      await this.run(
        { sessionId, role: s.role },
        'session.compliance',
        undefined,
        false,
        sessionId,
        async (t) => {
          const cur = (await t.getSession(sessionId)) ?? s
          await t.putSession({ ...cur, compliance: state })
        },
        { skipAuthz: true },
      )
    const notices: Notice[] = []
    const proposals: Proposal[] = []
    for (const f of fired) {
      if (f.check.action.includes('notice'))
        notices.push({
          level: 'warn',
          text: renderMessage(f.check.message ?? defaultMessage(f.check), metrics),
        })
      if (f.check.action.includes('proposal'))
        for (const d of complianceProposals(f.check.id, {
          sessionId,
          block: s.focus.blocks[0],
          openThreads,
          metrics,
        }))
          proposals.push(
            await this.proposalAdd(proposalOf(d, 'compliance'), { sessionId, role: s.role }),
          )
    }
    // measurable for the compliance harness (M6): how often the engine spoke to this session
    if (notices.length) await this.countersAdd(sessionId, { compliance_notices: notices.length })
    return { notices, proposals }
  }

  // ───────────────────────────── condensation ─────────────────────────────

  /** `hafiz checkpoint`: have the next shaping condense whatever it can. */
  async checkpointRequest(sessionId: string, on = true): Promise<boolean> {
    const s = await this.backend.read.getSession(sessionId)
    if (!s || s.endedAt) return false
    if (!!s.checkpointRequested === on) return true
    await this.run(
      { sessionId, role: s.role },
      'session.checkpoint',
      undefined,
      false,
      sessionId,
      async (t) => {
        const cur = (await t.getSession(sessionId)) ?? s
        const ns: Session = { ...cur, updatedAt: this.clock.now() }
        if (on) ns.checkpointRequested = true
        else delete ns.checkpointRequested
        await t.putSession(ns)
      },
      { skipAuthz: true },
    )
    return true
  }

  /** The session's current envelope text, without recording a view hash. */
  private async envelopeFor(s: Session): Promise<string> {
    const snap = await this.snapshot()
    return buildView(snap, this.config, this.tok, this.viewOptions(s.role, s.focus, {})).text
  }

  /**
   * Fold `turns` (the slice leaving the tail, ending at `through`) into the session's unfiled
   * summary. All-or-nothing: on any failure the previous summary and cursor stay, a warn notice
   * is returned, and the tail keeps its turns. Proposals go to the review queue, nothing else
   * is written to the store.
   */
  async sessionCondense(
    sessionId: string,
    args: { turns: CondenseTurn[]; through: CondenseCursor },
  ): Promise<{
    status: 'condensed' | 'skipped' | 'failed'
    summaryTokens?: number
    proposals: number
    notices: Notice[]
  }> {
    const skip = (why: string) => ({
      status: 'skipped' as const,
      proposals: 0,
      notices: [{ level: 'info' as const, text: why }],
    })
    const s = await this.backend.read.getSession(sessionId)
    if (!s) throw new NotFoundError('session', sessionId)
    if (!this.condenserEnabled) return skip('no condenser provider is configured')
    if (s.condensed?.fingerprint === args.through.fingerprint)
      return skip('already condensed up to that turn')
    if (!args.turns.length) return skip('nothing to condense')
    const actor: Actor = { sessionId, role: s.role }
    const cap = this.config.tail.unfiled.cap_tokens
    const input: CondenseInput = {
      previous: s.unfiledSummary ?? '',
      turns: args.turns,
      envelope: await this.envelopeFor(s),
      focus: s.focus.blocks,
      capTokens: cap,
    }
    let out: Awaited<ReturnType<Condenser['run']>>
    try {
      const provider = withRequestMeta(this.condenserProvider, { sessionId, purpose: 'condense' })
      out = await new Condenser(provider, this.tok).run(input)
    } catch (e) {
      const text = `condensation failed, keeping the previous summary: ${e instanceof Error ? e.message : String(e)}`
      await this.run(
        actor,
        'session.condense_failed',
        undefined,
        false,
        sessionId,
        async (t) => {
          const cur = (await t.getSession(sessionId)) ?? s
          const ns: Session = {
            ...cur,
            counters: bump(cur.counters, { [COST.condenseFailures]: 1 }),
          }
          delete ns.checkpointRequested
          await t.putSession(ns)
        },
        { skipAuthz: true },
      )
      return { status: 'failed', proposals: 0, notices: [{ level: 'warn', text }] }
    }
    const usage: LLMUsage = out.usage ?? {
      inputTokens:
        this.tok.count(input.previous) +
        this.tok.count(input.envelope) +
        args.turns.reduce((n, t) => n + this.tok.count(t.content), 0),
      outputTokens: this.tok.count(out.summary),
    }
    const notices: Notice[] = []
    if (out.truncated)
      notices.push({
        level: 'info',
        text: `unfiled summary exceeded ${cap} tokens and was truncated`,
      })
    if (out.dropped)
      notices.push({
        level: 'info',
        text: `${out.dropped} malformed condenser proposal(s) dropped`,
      })
    const drafts: Array<Omit<Proposal, 'id' | 'status' | 'createdAt'>> = []
    for (const p of out.proposals) {
      const block = p.block ?? s.focus.blocks[0]
      if (!block || !(await this.backend.read.getBlock(block))) {
        notices.push({
          level: 'info',
          text: `condenser ${p.kind} proposal dropped: no valid block`,
        })
        continue
      }
      drafts.push(condenserProposal(p.kind, block, p.payload))
    }
    await this.run(
      actor,
      'session.condense',
      undefined,
      false,
      sessionId,
      async (t) => {
        const cur = (await t.getSession(sessionId)) ?? s
        const ns: Session = {
          ...cur,
          unfiledSummary: out.summary,
          condensed: args.through,
          counters: bump(cur.counters, {
            [COST.condensations]: 1,
            [COST.condenseTokensIn]: usage.inputTokens,
            [COST.condenseTokensOut]: usage.outputTokens,
          }),
          updatedAt: this.clock.now(),
        }
        if (!out.summary) delete ns.unfiledSummary
        delete ns.checkpointRequested
        await t.putSession(ns)
        for (const d of drafts)
          await t.putProposal({
            ...d,
            id: opaqueId('prop'),
            status: 'pending',
            createdAt: this.clock.now(),
          })
      },
      { skipAuthz: true },
    )
    return {
      status: 'condensed',
      summaryTokens: this.tok.count(out.summary),
      proposals: drafts.length,
      notices,
    }
  }

  // ───────────────────────────── drafters ─────────────────────────────

  /** A gist draft for a thread, queued as a proposal (`thread.park` with the gist). */
  async draftGist(
    sessionId: string,
    threadId: string,
  ): Promise<{ gist: string; proposal: Proposal } | null> {
    if (!this.draftersEnabled) return null
    const th = await this.backend.read.getThread(threadId)
    if (!th) return null
    const provider = withRequestMeta(this.drafterProvider, { sessionId, purpose: 'gist' })
    const draft = await new Drafters(provider).gist(th, this.config.logs.thread.gist_cap)
    if (!draft) return null
    const gist = draft.value
    const proposal = await this.proposalAdd(
      {
        kind: 'gist',
        source: 'drafter',
        blockId: th.blockId,
        payload: { command: 'thread.park', args: { id: th.id, gist } },
        note: `drafted gist for thread "${th.title}": ${gist}`,
      },
      { sessionId, role: 'user' },
    )
    return { gist, proposal }
  }

  /** Digest sections are thin when the outcome is a few words or no pointers are given. */
  digestIsThin(digest: Record<string, SectionValue>): boolean {
    const outcome = typeof digest.outcome === 'string' ? digest.outcome : ''
    const pointers = Array.isArray(digest.pointers) ? digest.pointers : []
    return this.tok.count(outcome) < 15 || pointers.length === 0
  }

  /** A fuller digest drafted from the block's progress log, queued as a proposal. */
  async draftDigest(sessionId: string, blockId: BlockId): Promise<Proposal | null> {
    if (!this.draftersEnabled) return null
    const b = await this.backend.read.getBlock(blockId)
    if (!b) return null
    const log = (await this.backend.read.readLog(blockId, 'progress')).map((x) => x.entry)
    const provider = withRequestMeta(this.drafterProvider, { sessionId, purpose: 'digest' })
    const draft = await new Drafters(provider).digest(b, log)
    if (!draft) return null
    const d = draft.value
    const sections: Record<string, SectionValue> = { outcome: String(d.outcome) }
    sections.interface_delta = strList(d.interface_delta, ['none'])
    sections.pointers = (Array.isArray(d.pointers) ? d.pointers : [])
      .filter(
        (p): p is { label: string; ref: string } =>
          !!p && typeof p.label === 'string' && typeof p.ref === 'string',
      )
      .map((p) => ({ label: p.label, ref: p.ref }))
    const lessons = strList(d.lessons, [])
    if (lessons.length) sections.lessons = lessons
    return this.proposalAdd(
      {
        kind: 'digest',
        source: 'drafter',
        blockId,
        payload: { command: 'doc.write', args: { block: blockId, type: 'digest', sections } },
        note: `drafted digest for "${b.title}" (the submitted one looked thin): ${String(d.outcome)}`,
      },
      { sessionId, role: 'user' },
    )
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
    if (!s?.focus.computed) return s
    const role = this.config.roles.roles[s.role]
    if (role?.focus_policy !== 'all_active') return s
    const { result } = await this.run(
      { sessionId, role: s.role },
      'session.focus_refresh',
      undefined,
      false,
      sessionId,
      async (t) => {
        const ns = {
          ...((await t.getSession(sessionId)) ?? s),
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
    // (An 'auto_done' review item is already applied; a queued request_done carries confirmed: true.)
    const applied = p.source === 'auto_done' && p.payload.args.confirmed !== true
    if (args.accept && !applied) {
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

  /**
   * The block tree with what a UI draws per row (step progress, blocked-on, thread and decision
   * counts, the latest active decisions) and the standing decisions of the floor. Read-only, one
   * snapshot; gated like `tree.list`.
   */
  async treeSummary(by: Actor, opts: { recentDecisions?: number } = {}): Promise<TreeSummary> {
    authorize(this.config, by.role, 'tree.list')
    const snap = await this.snapshot()
    const recent = opts.recentDecisions ?? 3
    const brief = (d: DecisionView): DecisionBrief => ({
      id: d.id,
      blockId: d.blockId,
      title: d.title,
      decision: d.decision,
      ts: d.ts,
      ...(d.standing ? { standing: d.standing } : {}),
    })
    const nodes: TreeSummaryNode[] = []
    const standing: DecisionBrief[] = []
    for (const id of snap.treeOrder) {
      const b = snap.blocks.get(id)
      if (!b) continue
      const active = b.decisions.filter((d) => d.status === 'active')
      for (const d of active) if (d.standing) standing.push(brief(d))
      const steps = b.steps
      nodes.push({
        id,
        parentId: b.block.parentId,
        title: b.block.title,
        kind: b.block.kind,
        status: b.block.status,
        order: b.block.order,
        depth: snap.depth.get(id) ?? 0,
        ...(b.block.blockedOn ? { blockedOn: b.block.blockedOn } : {}),
        ...(steps.length
          ? {
              steps: {
                done: steps.filter((x) => x.status === 'done' || x.status === 'skipped').length,
                total: steps.length,
              },
            }
          : {}),
        docs: b.block.docVersions,
        threads: b.threads
          .filter((t) => t.status !== 'resolved')
          .map((t) => ({ id: t.id, title: t.title, status: t.status })),
        decisions: active.length,
        recentDecisions: active.slice(-recent).reverse().map(brief),
      })
    }
    return {
      project: snap.project
        ? { id: snap.project.id, name: snap.project.name, epoch: snap.project.epoch }
        : null,
      nodes,
      standing,
    }
  }

  /** Version history of a block's docs, newest first; gated like `block.read`. */
  async docHistory(by: Actor, id: BlockId, type?: DocType) {
    authorize(this.config, by.role, 'block.read')
    await this.mustBlock(this.backend.read, id)
    return this.backend.read.history(id, type)
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

  // ───────────────────────────── views ─────────────────────────────

  /** The largest `progress[-N:]` any zoom asks for: how much progress the snapshot loads. */
  private get progressDepth(): number {
    let n = 0
    for (const sels of Object.values(this.config.zooms.zooms))
      for (const raw of sels) {
        const sel = parseSelector(raw)
        if (sel.kind === 'progress') n = Math.max(n, sel.last)
      }
    return n
  }

  async snapshot(): Promise<Snapshot> {
    return loadSnapshot(this.backend.read, { progressLast: this.progressDepth })
  }

  private async viewSubject(by: Actor, opts: ContextOptions, snap: Snapshot) {
    if (opts.adhoc) {
      const role = this.config.roles.roles[opts.adhoc.role]
      if (!role) throw new ValidationError(`unknown role '${opts.adhoc.role}'`)
      const focus =
        opts.adhoc.focus ??
        focusFromPolicy(
          [...snap.blocks.values()].map((s) => s.block),
          role.focus_policy,
        )
      return { role: opts.adhoc.role, focus, session: null }
    }
    const session = await this.backend.read.getSession(by.sessionId)
    if (!session) throw new NotFoundError('session', by.sessionId)
    return { role: session.role, focus: session.focus, session }
  }

  private viewOptions(role: string, focus: Focus, opts: ContextOptions): ViewOptions {
    return {
      role,
      focus,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.budgetTokens !== undefined ? { budgetTokens: opts.budgetTokens } : {}),
    }
  }

  /** The session's structured prefix (§6). Records the hash; `changed` drives re-emission. */
  async contextFor(by: Actor, opts: ContextOptions = {}): Promise<ContextView> {
    authorize(this.config, by.role, 'context.for')
    const snap = await this.snapshot()
    const { role, focus, session } = await this.viewSubject(by, opts, snap)
    const v = buildView(snap, this.config, this.tok, this.viewOptions(role, focus, opts))
    const changed = v.hash !== session?.lastViewHash
    if (session && (changed || session.deltaCursor === undefined)) {
      const cursor = session.deltaCursor ?? (await this.backend.read.currentSeq())
      await this.run(
        by,
        'context.for',
        undefined,
        false,
        session.id,
        async (t) => {
          const cur = (await t.getSession(session.id)) ?? session
          await t.putSession({
            ...cur,
            counters: changed
              ? bump(cur.counters, { [COST.viewEmits]: 1, [COST.viewTokens]: v.tokens })
              : cur.counters,
            lastViewHash: v.hash,
            deltaCursor: cur.deltaCursor ?? cursor,
            updatedAt: this.clock.now(),
          })
        },
        { skipAuthz: true },
      )
    }
    return {
      text: v.text,
      hash: v.hash,
      floorText: v.floorText,
      manifest: v.manifest,
      notices: v.notices,
      budget: v.budget,
      tokens: v.tokens,
      changed,
    }
  }

  /** Which rule fired for a block, how it aggregated, which degrade steps touched it. */
  async contextExplain(
    by: Actor,
    blockId: BlockId,
    opts: ContextOptions = {},
  ): Promise<Explanation> {
    authorize(this.config, by.role, 'context.explain')
    const snap = await this.snapshot()
    const { role, focus } = await this.viewSubject(by, opts, snap)
    const v = buildView(snap, this.config, this.tok, this.viewOptions(role, focus, opts))
    return explain(v, snap, blockId)
  }

  /** Minor events on focus + dependencies since the last delivery; advances the cursor. */
  async contextDelta(by: Actor): Promise<DeltaResult> {
    authorize(this.config, by.role, 'context.delta')
    const session = await this.backend.read.getSession(by.sessionId)
    if (!session) throw new NotFoundError('session', by.sessionId)
    const snap = await this.snapshot()
    const role = this.config.roles.roles[session.role]
    const view = resolveView(this.config, role?.view ?? 'default')
    const start = session.deltaCursor ?? (await this.backend.read.currentSeq())
    const d = await computeDelta(this.backend.read, {
      cursor: start,
      blocks: deltaScope(snap, session.focus.blocks, view.dependencyDepth),
      capTokens: this.config.tail.delta.cap_tokens,
      tokenizer: this.tok,
      sessionId: session.id,
    })
    if (d.cursor !== session.deltaCursor)
      await this.run(
        by,
        'context.delta',
        undefined,
        false,
        session.id,
        async (t) => {
          const cur = (await t.getSession(session.id)) ?? session
          await t.putSession({
            ...cur,
            counters: d.text
              ? bump(cur.counters, { [COST.deltaTokens]: this.tok.count(d.text) })
              : cur.counters,
            deltaCursor: d.cursor,
            updatedAt: this.clock.now(),
          })
        },
        { skipAuthz: true },
      )
    return d
  }

  /** One block rendered at a zoom level. */
  async blockRead(by: Actor, id: BlockId, zoom = 'FULL'): Promise<string> {
    authorize(this.config, by.role, 'block.read')
    const snap = await this.snapshot()
    if (!snap.blocks.has(id)) throw new NotFoundError('block', id)
    return readBlock(snap, this.config, id, zoom)
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
    reg('proposal.accept', (b, a) => this.proposalResolve(b, { id: String(a.id), accept: true }))
    reg('proposal.reject', (b, a) => this.proposalResolve(b, { id: String(a.id), accept: false }))
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

function strList(v: unknown, fallback: string[]): string[] {
  const l = Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && !!x.trim())
    : []
  return l.length ? l : fallback
}

function defaultMessage(c: ComplianceCheck): string {
  return `Hafiz compliance check '${c.id}' tripped (${c.cond}).`
}

function proposalOf(
  d: ProposalDraft,
  source: Proposal['source'],
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  return {
    kind: d.kind,
    source,
    ...(d.blockId ? { blockId: d.blockId } : {}),
    payload: d.payload,
    note: d.note,
  }
}

/** A condenser proposal as the command it would run, with a note a reviewer can act on. */
function condenserProposal(
  kind: 'decision' | 'thread' | 'progress',
  block: BlockId,
  p: Record<string, unknown>,
): Omit<Proposal, 'id' | 'status' | 'createdAt'> {
  const text = (k: string) => String(p[k] ?? '')
  const base = { kind, source: 'condenser' as const, blockId: block }
  if (kind === 'decision')
    return {
      ...base,
      payload: { command: 'decision.record', args: { block, ...p } },
      note: `condenser: the user seems to have decided "${text('title')}": ${text('decision')}`,
    }
  if (kind === 'thread')
    return {
      ...base,
      payload: { command: 'thread.open', args: { block, ...p } },
      note: `condenser: unrecorded discussion "${text('title')}"${p.text ? `: ${text('text')}` : ''}`,
    }
  return {
    ...base,
    payload: { command: 'progress.append', args: { block, ...p } },
    note: `condenser: unrecorded ${text('kind')}: ${text('text')}`,
  }
}
