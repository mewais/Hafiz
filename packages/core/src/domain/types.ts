// Domain model. See docs/ARCHITECTURE.md §3.
// Plain data, JSON-serialisable; no methods. Behaviour lives in commands/ and view/.

export type BlockId = string
export type SessionId = string
export type ProjectId = string

export type Status = 'planned' | 'active' | 'blocked' | 'done' | 'dropped'
export const STATUSES: readonly Status[] = ['planned', 'active', 'blocked', 'done', 'dropped']

export type DocType = 'design' | 'plan' | 'digest'
export const DOC_TYPES: readonly DocType[] = ['design', 'plan', 'digest']

export type Standing = 'never' | 'always' | 'prefer'
export type StepStatus = 'todo' | 'doing' | 'done' | 'skipped'
export type ProgressKind = 'done' | 'blocked' | 'found' | 'changed' | 'question' | 'report'
export type ThreadStatus = 'open' | 'parked' | 'resolved'

/** Who performed a write. Every write is attributed. */
export interface Actor {
  sessionId: SessionId
  role: string
  /** Human-readable agent name, used as the git author. */
  agent?: string
}

export interface BlockedOn {
  kind: 'block' | 'thread' | 'user' | 'external'
  ref?: string
  note?: string
}

export interface Project {
  id: ProjectId
  name: string
  /** Hash of (git remote URL or path) + creator; the repo pointer must match it. */
  originFingerprint: string
  rootBlockId: BlockId
  schemaSetVersion: string
  /** Increments on major writes only. Internal invalidation signal, never a wire attribute. */
  epoch: number
  /**
   * `pending`: tracked in a repo that already had code; nothing is asked yet, so a one-off fix
   * costs no designer. `due`: tracked work has started (first block, first spawn on a block, or
   * a root doc write), so the manager is told to have the designer describe the code first.
   * Cleared when the root design is first written.
   */
  onboarding?: 'pending' | 'due'
  createdAt: string
}

export interface Block {
  id: BlockId
  parentId: BlockId | null
  title: string
  kind: string
  status: Status
  blockedOn?: BlockedOn
  /** Sibling ordering. */
  order: number
  /** CAS version for block metadata. */
  version: number
  /** Current version per doc type; 0 = absent. */
  docVersions: Record<DocType, number>
  /** Set on reopen; cleared when a fresh digest is written. */
  digestStale?: boolean
  /** Doc versions approved through the review queue (§7), e.g. `{ design: 3, plan: 1 }`. */
  reviewed?: Partial<Record<ReviewType, number>>
  doneAt?: { ts: string; commit?: string }
  createdAt: string
  updatedAt: string
}

/**
 * Section values by schema format:
 *  prose → string · list → string[] · refs → Ref[] · structured → StructuredInterface
 *  steps → Step[]
 */
export type SectionValue = string | string[] | Ref[] | Step[] | StructuredInterface

export interface Ref {
  label: string
  ref: string
}
export interface Step {
  id: string
  title: string
  notes?: string
}
export interface StructuredInterface {
  provides?: Contract[]
  consumes?: Contract[]
  contracts?: Contract[]
}
export interface Contract {
  name: string
  type?: string
  notes?: string
  /** On a `consumes` entry: the providing block (its id). Design writes derive edges from it. */
  block?: string
}

export interface Doc {
  blockId: BlockId
  type: DocType
  version: number
  sections: Record<string, SectionValue>
  updatedAt: string
  by: Actor
}

export interface Edge {
  from: BlockId
  to: BlockId
  kind: string
}

export interface StepEvent {
  blockId: BlockId
  stepId: string
  status: StepStatus
  ts: string
  by: Actor
}

export interface ProgressEntry {
  id: string
  blockId: BlockId
  ts: string
  by: Actor
  kind: ProgressKind
  text: string
  refs: string[]
}

/**
 * Append-only. A decision is superseded when a later decision's `supersedes` names it;
 * `status` is derived at read time, never stored.
 */
export interface Decision {
  id: string
  blockId: BlockId
  ts: string
  by: Actor
  title: string
  decision: string
  rationale?: string
  /** Present → a standing instruction rendered in the view floor. */
  standing?: Standing
  supersedes?: string
}

export interface ThreadEntry {
  ts: string
  by: Actor
  text: string
}

export interface Thread {
  id: string
  blockId: BlockId
  title: string
  status: ThreadStatus
  gist?: string
  entries: ThreadEntry[]
  createdAt: string
  updatedAt: string
  by: Actor
}

export type ProposalKind =
  | 'decision'
  | 'thread'
  | 'progress'
  | 'digest'
  | 'gist'
  | 'status'
  | ReviewType
export type ProposalSource = 'condenser' | 'drafter' | 'compliance' | 'auto_done' | 'review'

/** Docs the review queue files for approval (`policies.yaml review`). */
export type ReviewType = 'design' | 'plan'
export const REVIEW_TYPES: readonly ReviewType[] = ['design', 'plan']
/** A `policies.yaml review` row: no proposal, a proposal, or a proposal that holds the block. */
export type ReviewMode = 'off' | 'queue' | 'gate'

export interface Proposal {
  id: string
  kind: ProposalKind
  source: ProposalSource
  blockId?: BlockId
  /** The command this proposal would perform if accepted. */
  payload: { command: string; args: Record<string, unknown> }
  note?: string
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: string
  resolvedAt?: string
  resolvedBy?: Actor
  /** Why it was rejected (`proposal.reject` with a note); the reviewers hear it. */
  resolutionNote?: string
}

export interface Focus {
  blocks: BlockId[]
  /** Priority order for degradation; defaults to `blocks` order. */
  order?: BlockId[]
  /** True when set from the role's focus_policy rather than by `focus.set`. */
  computed: boolean
}

/** Bookkeeping the compliance engine keeps per session (§7). */
export interface ComplianceState {
  /** Checks whose condition currently holds; a check fires again only after it was false. */
  active: string[]
  /** Store log cursor for counting this session's progress entries incrementally. */
  seq: number
  /** Progress entries written by this session. */
  progress: number
  /** `turns` counter when progress last grew. */
  progressTurn: number
  /** Threads opened by this session. */
  threads: number
  /** `user_turns` counter when a thread was last opened. */
  userTurnsAtThread: number
}

/** Where the condenser stopped: turns up to and including this one are covered by the summary. */
export interface CondenseCursor {
  /** Position in the host conversation when condensed (hint; the fingerprint is authoritative). */
  index: number
  /** sha256 prefix of `role \0 content` of the last condensed turn. */
  fingerprint: string
}

export interface Session {
  /** Host session id where available, so reconnects re-attach. */
  id: SessionId
  projectId: ProjectId
  host: string
  role: string
  agent?: string
  /** Capability token minted by the adapter at spawn. */
  token: string
  parentSessionId?: SessionId
  /** The working tree (git top level) the session runs in; HEAD at `done` is read here. */
  worktree?: string
  focus: Focus
  counters: Record<string, number>
  lastViewHash?: string
  unfiledSummary?: string
  /** Leading turns of the host conversation already folded into `unfiledSummary`. */
  condensed?: CondenseCursor
  /** `hafiz checkpoint` asked for a condensation at the next shaping. */
  checkpointRequested?: boolean
  compliance?: ComplianceState
  /** Delta channel cursor: last log sequence delivered. */
  deltaCursor?: number
  createdAt: string
  updatedAt: string
  endedAt?: string
}

export interface AuditEntry {
  ts: string
  by: Actor
  command: string
  target: string
  versionBefore?: number
  versionAfter?: number
  commit?: string
}

/** Derived view of a decision with its computed status. */
export interface DecisionView extends Decision {
  status: 'active' | 'superseded'
}

export function deriveDecisionStatus(all: readonly Decision[]): DecisionView[] {
  const superseded = new Set(all.map((d) => d.supersedes).filter((s): s is string => !!s))
  return all.map((d) => ({ ...d, status: superseded.has(d.id) ? 'superseded' : 'active' }))
}
