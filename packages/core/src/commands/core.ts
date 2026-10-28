// The Core service: every write and read agents can perform, host-agnostic. Gateways map onto
// these 1:1. See docs/ARCHITECTURE.md §5. This class is a facade: it builds the shared
// `CoreContext`, holds the LLM providers and the compliance engine, and delegates to the modules
// (one per box of §2); it owns the command table that `dispatch` serves.

import { digestIsThin, draftDigest, draftersEnabled, draftGist } from '../condense/drafting.js'
import {
  type CondenseArgs,
  checkpointRequest,
  condenserEnabled,
  sessionCondense,
} from '../condense/service.js'
import type { Config } from '../config/schema.js'
import { type Clock, systemClock } from '../domain/clock.js'
import { ValidationError } from '../domain/errors.js'
import { StatusMachine } from '../domain/status.js'
import type {
  Actor,
  BlockId,
  DocType,
  Proposal,
  ReviewType,
  SectionValue,
  Session,
} from '../domain/types.js'
import { createProvider, NoneProvider } from '../llm/providers.js'
import type { LLMProvider, LLMRelay } from '../llm/types.js'
import { ComplianceEngine, type ComplianceWhen } from '../session/compliance.js'
import { complianceRun } from '../session/compliance-run.js'
import {
  activeAgents,
  countersAdd,
  type FocusSetArgs,
  focusSet,
  refreshAgentFocus,
  refreshComputedFocus,
  refreshStaleFocus,
  type SessionOpenArgs,
  sessionEnd,
  sessionOpen,
} from '../session/service.js'
import type { StorageBackend } from '../store/backend.js'
import { estimatorTokenizer, type Tokenizer } from '../tokenizer.js'
import {
  blockRead,
  type ContextOptions,
  contextDelta,
  contextExplain,
  contextFor,
  snapshot,
} from '../view/service.js'
import {
  type BlockCreateArgs,
  type BlockMoveArgs,
  type BlockRequestDoneArgs,
  type BlockSetStatusArgs,
  type BlockUpdateArgs,
  blockCreate,
  blockMove,
  blockRequestDone,
  blockSetStatus,
  blockUpdate,
  type EdgeArgs,
  edgeAdd,
  edgeRemove,
} from './blocks.js'
import { COMMAND_SPECS, type CommandSpec } from './catalogue.js'
import { type DocWriteArgs, docPatch, docWrite } from './docs.js'
import { AFTER_HOOKS, BEFORE_HOOKS, type DispatchSink, type HookCall, NO_SINK } from './hooks.js'
import {
  type DecisionRecordArgs,
  decisionRecord,
  type ProgressAppendArgs,
  progressAppend,
  type StepSetArgs,
  type SystemProgressArgs,
  stepSet,
  systemProgress,
  type ThreadAppendArgs,
  type ThreadOpenArgs,
  type ThreadParkArgs,
  type ThreadResolveArgs,
  threadAppend,
  threadOpen,
  threadPark,
  threadResolve,
  threadResume,
} from './logs.js'
import {
  allDocs,
  type ProjectInitArgs,
  projectInit,
  type SchemaMigrateArgs,
  schemaMigrate,
} from './project.js'
import {
  type NewProposal,
  type ProposalResolveArgs,
  proposalAdd,
  proposalResolve,
} from './proposals.js'
import {
  blockDetail,
  blockDetailRaw,
  docHistory,
  treeList,
  treeListRaw,
  treeSummary,
} from './reads.js'
import { fileCreated, fileSessionReviews, reviewList, reviewShow } from './review.js'
import type { CommandResult, CoreContext } from './tx.js'

export { focusFromPolicy } from '../session/service.js'
export type { ContextOptions, ContextView } from '../view/service.js'
export type { NeedsConfirmation } from './blocks.js'
export type { DispatchSink } from './hooks.js'
export type { BlockDetail, DecisionBrief, TreeSummary, TreeSummaryNode } from './reads.js'
export {
  changedSections,
  changedSince,
  docAtVersion,
  type ReviewItem,
  type ReviewShow,
  type SectionChange,
} from './review.js'
export type { CommandResult, CoreContext } from './tx.js'

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

/** The arguments of every command `dispatch` serves (Core's camelCase names). */
export interface CommandArgs {
  'block.create': BlockCreateArgs
  'block.update': BlockUpdateArgs
  'block.move': BlockMoveArgs
  'block.set_status': BlockSetStatusArgs
  'block.request_done': BlockRequestDoneArgs
  'edge.add': EdgeArgs
  'edge.remove': EdgeArgs
  'doc.write': DocWriteArgs
  'doc.patch': DocWriteArgs
  'step.set': StepSetArgs
  'progress.append': ProgressAppendArgs
  'decision.record': DecisionRecordArgs
  'thread.open': ThreadOpenArgs
  'thread.park': ThreadParkArgs
  'thread.resume': { id: string }
  'thread.resolve': ThreadResolveArgs
  'thread.append': ThreadAppendArgs
  'focus.set': FocusSetArgs
  'proposal.accept': { id: string; note?: string }
  'proposal.reject': { id: string; note?: string }
}

export type CommandName = keyof CommandArgs

type CommandHandlers = {
  [K in CommandName]: (by: Actor, args: CommandArgs[K]) => Promise<CommandResult<unknown>>
}

/** A handler as `dispatch` calls it: the args come off the wire and each command checks them. */
type Handler = (by: Actor, args: Record<string, unknown>) => Promise<CommandResult<unknown>>

export class Core {
  readonly config: Config
  readonly backend: StorageBackend
  readonly tok: Tokenizer
  readonly clock: Clock
  readonly status: StatusMachine
  readonly compliance: ComplianceEngine
  readonly condenserProvider: LLMProvider
  readonly drafterProvider: LLMProvider
  /** What every module works over. */
  readonly ctx: CoreContext
  private readonly handlers: ReadonlyMap<string, Handler>
  /** The catalogue entry of each dispatchable command: its before/after hooks. */
  private readonly hooks: ReadonlyMap<string, CommandSpec> = new Map(
    COMMAND_SPECS.filter((t) => t.kind === 'dispatch').map((t) => [t.command, t]),
  )

  constructor(deps: CoreDeps) {
    this.config = deps.config
    this.backend = deps.backend
    this.tok = deps.tokenizer ?? estimatorTokenizer
    this.clock = deps.clock ?? systemClock
    this.status = new StatusMachine(this.config.policies.status)
    this.compliance = new ComplianceEngine(this.config.compliance.checks)
    this.ctx = {
      config: this.config,
      backend: this.backend,
      tok: this.tok,
      clock: this.clock,
      status: this.status,
      repoDir: deps.repoDir,
    }
    const io = { env: deps.env ?? process.env, ...(deps.relay ? { relay: deps.relay } : {}) }
    const llm = this.config.hafiz.llm
    this.condenserProvider = deps.llm?.condenser ?? createProvider(llm.condenser, io)
    this.drafterProvider =
      deps.llm?.drafter ??
      (llm.drafters.enabled ? createProvider(llm.drafters, io) : new NoneProvider())
    this.handlers = this.commandHandlers()
  }

  /** True when a condenser provider is configured (otherwise the host keeps its own compaction). */
  get condenserEnabled(): boolean {
    return condenserEnabled(this.condenserProvider)
  }

  get draftersEnabled(): boolean {
    return draftersEnabled(this.ctx, this.drafterProvider)
  }

  // ───────────────────────────── project ─────────────────────────────

  projectInit(by: Actor, args: ProjectInitArgs) {
    return projectInit(this.ctx, by, args)
  }
  schemaMigrate(by: Actor, args: SchemaMigrateArgs) {
    return schemaMigrate(this.ctx, by, args)
  }
  allDocs() {
    return allDocs(this.ctx)
  }

  // ───────────────────────────── blocks & edges ─────────────────────────────

  blockCreate(by: Actor, args: BlockCreateArgs) {
    return blockCreate(this.ctx, by, args)
  }
  blockUpdate(by: Actor, args: BlockUpdateArgs) {
    return blockUpdate(this.ctx, by, args)
  }
  blockMove(by: Actor, args: BlockMoveArgs) {
    return blockMove(this.ctx, by, args)
  }
  blockSetStatus(by: Actor, args: BlockSetStatusArgs) {
    return blockSetStatus(this.ctx, by, args)
  }
  blockRequestDone(by: Actor, args: BlockRequestDoneArgs) {
    return blockRequestDone(this.ctx, by, args)
  }
  edgeAdd(by: Actor, args: EdgeArgs) {
    return edgeAdd(this.ctx, by, args)
  }
  edgeRemove(by: Actor, args: EdgeArgs) {
    return edgeRemove(this.ctx, by, args)
  }

  // ───────────────────────────── docs ─────────────────────────────

  docWrite(by: Actor, args: DocWriteArgs) {
    return docWrite(this.ctx, by, args)
  }
  docPatch(by: Actor, args: DocWriteArgs) {
    return docPatch(this.ctx, by, args)
  }

  // ───────────────────────────── logs & threads ─────────────────────────────

  stepSet(by: Actor, args: StepSetArgs) {
    return stepSet(this.ctx, by, args)
  }
  progressAppend(by: Actor, args: ProgressAppendArgs) {
    return progressAppend(this.ctx, by, args)
  }
  /** Hafiz's own note on a block (system write; not reachable through `dispatch`). */
  systemProgress(by: Actor, args: SystemProgressArgs) {
    return systemProgress(this.ctx, by, args)
  }
  decisionRecord(by: Actor, args: DecisionRecordArgs) {
    return decisionRecord(this.ctx, by, args)
  }
  threadOpen(by: Actor, args: ThreadOpenArgs) {
    return threadOpen(this.ctx, by, args)
  }
  threadPark(by: Actor, args: ThreadParkArgs) {
    return threadPark(this.ctx, by, args)
  }
  threadResume(by: Actor, args: { id: string }) {
    return threadResume(this.ctx, by, args)
  }
  threadResolve(by: Actor, args: ThreadResolveArgs) {
    return threadResolve(this.ctx, by, args)
  }
  threadAppend(by: Actor, args: ThreadAppendArgs) {
    return threadAppend(this.ctx, by, args)
  }

  // ───────────────────────────── sessions & focus ─────────────────────────────

  sessionOpen(args: SessionOpenArgs) {
    return sessionOpen(this.ctx, args)
  }
  /**
   * End a session. First the designs and plans it wrote go up for review (`policies.yaml
   * review`); the proposals filed are returned for the gateway to announce.
   */
  async sessionEnd(sessionId: string): Promise<{ proposals: Proposal[] }> {
    const proposals = await fileSessionReviews(this.ctx, sessionId)
    await sessionEnd(this.ctx, sessionId)
    return { proposals }
  }
  countersAdd(sessionId: string, delta: Record<string, number>) {
    return countersAdd(this.ctx, sessionId, delta)
  }
  focusSet(by: Actor, args: FocusSetArgs) {
    return focusSet(this.ctx, by, args)
  }
  refreshComputedFocus(sessionId: string) {
    return refreshComputedFocus(this.ctx, sessionId)
  }
  /** Refresh a session's computed focus only if its policy now yields a different set. */
  refreshStaleFocus(s: Session) {
    return refreshStaleFocus(this.ctx, s)
  }
  /** Keep every live agent's computed focus current. */
  refreshAgentFocus() {
    return refreshAgentFocus(this.ctx)
  }
  /** Live agent sessions (the read-only viewer left out). */
  activeAgents() {
    return activeAgents(this.ctx)
  }
  complianceRun(sessionId: string, when: ComplianceWhen) {
    return complianceRun(this.ctx, this.compliance, sessionId, when)
  }

  // ───────────────────────────── condensation & drafters ─────────────────────────────

  checkpointRequest(sessionId: string, on = true) {
    return checkpointRequest(this.ctx, sessionId, on)
  }
  sessionCondense(sessionId: string, args: CondenseArgs) {
    return sessionCondense(this.ctx, this.condenserProvider, sessionId, args)
  }
  draftGist(sessionId: string, threadId: string) {
    return draftGist(this.ctx, this.drafterProvider, sessionId, threadId)
  }
  digestIsThin(digest: Record<string, SectionValue>) {
    return digestIsThin(this.ctx, digest)
  }
  draftDigest(sessionId: string, blockId: BlockId) {
    return draftDigest(this.ctx, this.drafterProvider, sessionId, blockId)
  }

  // ───────────────────────────── proposals ─────────────────────────────

  proposalResolve(by: Actor, args: ProposalResolveArgs) {
    return proposalResolve(this.ctx, by, args, (b, command, a) => {
      const h = this.handlers.get(command)
      if (!h) throw new ValidationError(`proposal command '${command}' is not executable`)
      return h(b, a)
    })
  }
  proposalAdd(p: NewProposal, by: Actor) {
    return proposalAdd(this.ctx, p, by)
  }
  /** Pending proposals (or those of `status`, or `all`) with their review-table row. */
  reviewList(by: Actor, status: Proposal['status'] | 'all' = 'pending', resolvable = false) {
    return reviewList(this.ctx, by, status, resolvable)
  }
  /** A proposal and the doc it is about, at the version under review. */
  reviewShow(by: Actor, id: string) {
    return reviewShow(this.ctx, by, id)
  }
  /** File the reviews of a block created with an inline design or plan (`block.create` hook). */
  reviewFileCreated(by: Actor, block: BlockId, types: readonly ReviewType[]) {
    return fileCreated(this.ctx, by, block, types)
  }

  // ───────────────────────────── reads & views ─────────────────────────────

  treeList(by: Actor) {
    return treeList(this.ctx, by)
  }
  treeListRaw() {
    return treeListRaw(this.ctx)
  }
  treeSummary(by: Actor, opts: { recentDecisions?: number } = {}) {
    return treeSummary(this.ctx, by, opts)
  }
  docHistory(by: Actor, id: BlockId, type?: DocType) {
    return docHistory(this.ctx, by, id, type)
  }
  blockDetail(by: Actor, id: BlockId) {
    return blockDetail(this.ctx, by, id)
  }
  blockDetailRaw(id: BlockId) {
    return blockDetailRaw(this.ctx, id)
  }
  snapshot() {
    return snapshot(this.ctx)
  }
  contextFor(by: Actor, opts: ContextOptions = {}) {
    return contextFor(this.ctx, by, opts)
  }
  contextExplain(by: Actor, blockId: BlockId, opts: ContextOptions = {}) {
    return contextExplain(this.ctx, by, blockId, opts)
  }
  contextDelta(by: Actor) {
    return contextDelta(this.ctx, by)
  }
  blockRead(by: Actor, id: BlockId, zoom = 'FULL') {
    return blockRead(this.ctx, by, id, zoom)
  }

  // ───────────────────────────── dispatch ─────────────────────────────

  /** Every role-gated command `dispatch` (and proposal acceptance) can run. */
  private commandHandlers(): ReadonlyMap<string, Handler> {
    const table: CommandHandlers = {
      'block.create': (b, a) => this.blockCreate(b, a),
      'block.update': (b, a) => this.blockUpdate(b, a),
      'block.move': (b, a) => this.blockMove(b, a),
      'block.set_status': (b, a) => this.blockSetStatus(b, a),
      'block.request_done': (b, a) => this.blockRequestDone(b, a),
      'edge.add': (b, a) => this.edgeAdd(b, a),
      'edge.remove': (b, a) => this.edgeRemove(b, a),
      'doc.write': (b, a) => this.docWrite(b, a),
      'doc.patch': (b, a) => this.docPatch(b, a),
      'step.set': (b, a) => this.stepSet(b, a),
      'progress.append': (b, a) => this.progressAppend(b, a),
      'decision.record': (b, a) => this.decisionRecord(b, a),
      'thread.open': (b, a) => this.threadOpen(b, a),
      'thread.park': (b, a) => this.threadPark(b, a),
      'thread.resume': (b, a) => this.threadResume(b, a),
      'thread.resolve': (b, a) => this.threadResolve(b, a),
      'thread.append': (b, a) => this.threadAppend(b, a),
      'focus.set': (b, a) => this.focusSet(b, a),
      'proposal.accept': (b, a) => this.proposalResolve(b, { ...a, accept: true }),
      'proposal.reject': (b, a) => this.proposalResolve(b, { ...a, accept: false }),
    }
    // The one untyped seam: wire args are not checked against `CommandArgs` here; each command
    // validates what it reads (as it did before the table was typed).
    return new Map(Object.entries(table) as Array<[string, Handler]>)
  }

  /**
   * Generic entry point used by gateways: the command with the hooks its catalogue entry
   * declares around it. `sink` receives what the hooks have for the gateway (queued notices,
   * proposals to announce).
   */
  async dispatch(
    by: Actor,
    command: string,
    args: Record<string, unknown>,
    sink: DispatchSink = NO_SINK,
  ): Promise<CommandResult<unknown>> {
    const h = this.handlers.get(command)
    if (!h) throw new ValidationError(`unknown command '${command}'`)
    const spec = this.hooks.get(command)
    const call: HookCall = { by, command, args, sink }
    for (const name of spec?.before ?? []) await BEFORE_HOOKS[name](this, call)
    let out = await h(by, args)
    const after: HookCall = { ...call, result: out.result }
    for (const name of spec?.after ?? []) {
      const extra = await AFTER_HOOKS[name](this, after)
      if (extra?.length) out = { ...out, notices: [...out.notices, ...extra] }
    }
    return out
  }
}
