// Metric collection (M6): everything is read back from the Hafiz store (logs, threads, proposals,
// audit) and the session counters the cost instrumentation and compliance engine already keep.
// Only agent sessions count; the seed and `hafiz` CLI calls run as role `user` and are ignored.
import { costTotal, type ReadOps, type Session, TOOL_SPECS } from '@hafiz/core'

export type MetricValue = number | null
export type MetricSet = Record<string, MetricValue>

export interface RunMetrics {
  /** All agent roles together. */
  total: MetricSet
  /** Per agent role (manager, designer, planner, worker). */
  roles: Record<string, MetricSet>
}

const REPORT = 'report'
/** Commands that change the store (the catalogue's dispatch tools); audit also records reads. */
const WRITES = new Set(TOOL_SPECS.filter((t) => t.kind === 'dispatch').map((t) => t.command))
const sum = (xs: Iterable<number>) => {
  let n = 0
  for (const x of xs) n += x
  return n
}
const counter = (ss: readonly Session[], k: string) => sum(ss.map((s) => s.counters[k] ?? 0))
const ratio = (a: number, b: number): MetricValue => (b > 0 ? a / b : null)

/** The metrics of one group of sessions (one role, or all of them). */
function metricsFor(
  sessions: readonly Session[],
  a: {
    isMine: (by: { sessionId: string; role: string }) => boolean
    progress: Array<{ kind: string; by: { sessionId: string; role: string } }>
    steps: Array<{ by: { sessionId: string; role: string } }>
    decisions: Array<{ standing?: string; by: { sessionId: string; role: string } }>
    threads: Array<{ status: string; by: { sessionId: string; role: string } }>
    audit: Array<{ command: string; target: string; by: { sessionId: string; role: string } }>
    /** Blocks that have a digest doc. */
    digested: ReadonlySet<string>
    proposals: Array<{ source: string; kind: string }>
  },
): MetricSet {
  const mine = <T extends { by: { sessionId: string; role: string } }>(xs: T[]) =>
    xs.filter((x) => a.isMine(x.by))
  const progress = mine(a.progress)
  const audit = mine(a.audit)
  const cmd = (c: string) => audit.filter((e) => e.command === c || e.command.startsWith(`${c}:`))
  // `confirm_done: auto` turns request_done into set_status:done; `ask` queues a request.
  const done = [...cmd('block.request_done'), ...cmd('block.set_status:done')]
  const tools = counter(sessions, 'tool_calls')
  const protocol = counter(sessions, 'tool_calls_hafiz')
  const cost = costTotal(sessions)
  const m: MetricSet = {
    sessions: sessions.length,
    decisions: mine(a.decisions).length,
    decisions_standing: mine(a.decisions).filter((d) => d.standing).length,
    progress: progress.filter((p) => p.kind !== REPORT).length,
    reports: progress.filter((p) => p.kind === REPORT).length,
    steps: mine(a.steps).length,
    threads_opened: mine(a.threads).length,
    threads_parked: cmd('thread.park').length,
    threads_open_at_end: mine(a.threads).filter((t) => t.status === 'open').length,
    request_done: done.length,
    request_done_digest: done.filter((e) => a.digested.has(e.target)).length,
    blocks_created: cmd('block.create').length,
    docs_written: audit.filter((e) => /^doc\.(write|patch)/.test(e.command)).length,
    cap_rejections: counter(sessions, 'cap_rejections'),
    retries: counter(sessions, 'retries_after_reject'),
    compliance_notices: counter(sessions, 'compliance_notices'),
    nudges: counter(sessions, 'nudges'),
    tool_calls: tools,
    hafiz_calls: protocol,
    protocol_ratio: ratio(protocol, tools),
    files_written: counter(sessions, 'files_written'),
    subagents_spawned: counter(sessions, 'subagents_spawned'),
    view_emits: cost.viewEmits,
    tokens_per_view: cost.tokensPerView,
    cache_read_ratio: cost.cacheHit,
    condensations: cost.condensations,
    condense_tokens: cost.condenseTokens,
    hafiz_writes: audit.filter((e) => WRITES.has(e.command.split(':')[0] as string)).length,
  }
  return m
}

/** Read everything a run produced and compute the metrics. */
export async function collectMetrics(read: ReadOps): Promise<RunMetrics> {
  const [all, blocks, proposals, audit, threads] = await Promise.all([
    read.listSessions(),
    read.listBlocks(),
    read.listProposals(),
    read.readAudit(),
    read.listThreads(),
  ])
  const sessions = all.filter((s) => s.role !== 'user')
  const agent = (by: { role: string }) => by.role !== 'user'
  const progress: Array<{ kind: string; by: { sessionId: string; role: string } }> = []
  const steps: Array<{ by: { sessionId: string; role: string } }> = []
  const decisions: Array<{ standing?: string; by: { sessionId: string; role: string } }> = []
  for (const b of blocks) {
    for (const e of await read.readLog(b.id, 'progress')) progress.push(e.entry)
    for (const e of await read.readLog(b.id, 'steps')) steps.push(e.entry)
    for (const e of await read.readLog(b.id, 'decisions')) decisions.push(e.entry)
  }
  const data = {
    digested: new Set(blocks.filter((b) => b.docVersions.digest > 0).map((b) => b.id)),
    progress: progress.filter((e) => agent(e.by)),
    steps: steps.filter((e) => agent(e.by)),
    decisions: decisions.filter((e) => agent(e.by)),
    threads: threads.filter((t) => agent(t.by)),
    audit: audit.filter((e) => agent(e.by)),
    proposals,
  }
  const total = metricsFor(sessions, { ...data, isMine: agent })
  total.blocks_done = blocks.filter((b) => b.status === 'done' && b.parentId !== null).length
  total.blocks_total = blocks.length
  total.proposals = proposals.length
  for (const source of ['condenser', 'drafter', 'compliance', 'auto_done'])
    total[`proposals_${source}`] = proposals.filter((p) => p.source === source).length

  const roles: Record<string, MetricSet> = {}
  for (const role of [...new Set(sessions.map((s) => s.role))].sort()) {
    const ss = sessions.filter((s) => s.role === role)
    roles[role] = metricsFor(ss, { ...data, isMine: (by) => by.role === role })
  }
  // progress per worker session (the protocol asks every worker to log as it goes)
  if (roles.worker) {
    const per = sessions
      .filter((s) => s.role === 'worker')
      .map((s) => data.progress.filter((p) => p.by.sessionId === s.id && p.kind !== REPORT).length)
    roles.worker.progress_min = Math.min(...per)
    roles.worker.progress_avg = sum(per) / per.length
    total.worker_progress_min = roles.worker.progress_min
  }
  return { total, roles }
}
