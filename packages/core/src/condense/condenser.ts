// The condenser: the one LLM call in the loop (§6.5). It folds the turns leaving the verbatim
// tail into a rolling "unfiled" summary and proposes records for things the agents should have
// written to the store and did not. Output is strict JSON; parsing is defensive and a failure
// never loses anything: the caller keeps the previous summary and the tail keeps its turns.
import { z } from 'zod'
import type { LLMProvider, LLMUsage } from '../llm/types.js'
import type { Tokenizer } from '../tokenizer.js'

export interface CondenseTurn {
  role: string
  content: string
  toolName?: string | undefined
}

export interface CondenseInput {
  /** Previous unfiled summary ('' when none). */
  previous: string
  /** The slice leaving the tail, oldest first. */
  turns: CondenseTurn[]
  /** The session's current `<hafiz>` envelope: already covered, to be excluded. */
  envelope: string
  /** Blocks the session is working on; proposals default to the first. */
  focus: string[]
  capTokens: number
}

export type ProposalKindOut = 'decision' | 'thread' | 'progress'

export interface CondenseProposal {
  kind: ProposalKindOut
  block?: string
  payload: Record<string, unknown>
}

export interface CondenseOutput {
  summary: string
  proposals: CondenseProposal[]
  /** Summary exceeded the cap and was cut. */
  truncated: boolean
  /** Proposals dropped as malformed. */
  dropped: number
  usage?: LLMUsage | undefined
}

export class CondenseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CondenseError'
  }
}

export const MAX_PROPOSALS = 6
/** Per-turn character cap in the prompt: tool output is clipped, conversation is not. */
const TOOL_CLIP = 1600
const TURN_CLIP = 12000

export const CONDENSER_SYSTEM = `You maintain the working memory of a long coding session between a user and an AI agent. The agent's context window is nearly full; the oldest turns are about to be removed from it. You write the note that replaces them.

You receive:
  <previous_summary>  the note you wrote last time (may be "(none)")
  <envelope>          the project record the agent already has in context: designs, plans, decisions, progress, threads. It is ALREADY COVERED.
  <turns>             the conversation turns being removed, oldest first, numbered

Produce the new summary. It must stand in for the removed turns and the previous summary together.

WHAT TO KEEP, nearly verbatim where it matters:
- What the user asked for and why: their goals, constraints, preferences, corrections, and any wording that carries intent. Quote short phrases exactly.
- Open questions: asked and unanswered, or answered only partially.
- In-flight reasoning: hypotheses being tested, approaches tried and abandoned (with the reason), partial findings, the exact next step that was about to happen.
- Concrete handles the agent will need again: file paths, function and symbol names, commands that worked, error messages that mattered.

WHAT TO LEAVE OUT:
- Anything the envelope already states. Do not restate designs, plans, decisions, progress entries or threads that appear there, even in other words.
- Pleasantries, tool output that led nowhere, repeated attempts, and narration of routine steps.
- Old material from the previous summary that the turns resolved or made obsolete.

Write plain, dense prose or short bullet lines. Do not address the agent. Do not invent anything. Stay within the stated token budget; if you must cut, cut the oldest and least actionable material first, never the user's intent.

PROPOSALS: also list records the agent should have written to the project store and did not. The user reviews them later; be conservative and propose only what is clearly warranted.
- "decision": ONLY something the USER actually decided or explicitly approved (not something the agent suggested and the user never confirmed). payload: {"title": short, "decision": one or two sentences, "rationale": optional, "standing": optional "never"|"always"|"prefer" when the user gave a lasting instruction}.
- "thread": a discussion or open question that went several turns without being recorded. payload: {"title": short, "text": the state of the discussion in a few sentences}.
- "progress": work finished, blocked, or discovered that the log does not show. payload: {"kind": "done"|"blocked"|"found"|"changed"|"question", "text": one finding, one or two sentences}.
Each proposal may carry "block": the id of the block it belongs to, taken from the envelope; omit it to mean the session's focus block. Never propose something the envelope already records. An empty list is the normal answer.

OUTPUT: exactly one JSON object and nothing else, no code fence, no commentary:
{"summary": "<string>", "proposals": [{"kind": "decision"|"thread"|"progress", "block": "<id, optional>", "payload": {...}}]}`

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${s.slice(0, head)}\n[… ${s.length - max} characters omitted …]\n${s.slice(-tail)}`
}

export function renderTurns(turns: readonly CondenseTurn[]): string {
  return turns
    .map((t, i) => {
      const label = t.role === 'tool' ? `tool ${t.toolName ?? ''}`.trim() : t.role
      return `[${label} #${i + 1}] ${clip(t.content, t.role === 'tool' ? TOOL_CLIP : TURN_CLIP)}`
    })
    .join('\n\n')
}

export function condenserPrompt(input: CondenseInput): string {
  return [
    `Token budget for the summary: ${input.capTokens}.`,
    `<previous_summary>\n${input.previous.trim() || '(none)'}\n</previous_summary>`,
    `<envelope>\n${input.envelope.trim() || '(none)'}\n</envelope>`,
    `<turns>\n${renderTurns(input.turns)}\n</turns>`,
  ].join('\n\n')
}

/** Cut `text` to `cap` tokens keeping the newest lines; the cut is marked. */
export function truncateSummary(text: string, cap: number, tok: Tokenizer): string {
  if (tok.count(text) <= cap) return text
  const marker = '[older context trimmed]\n'
  const lines = text.split('\n')
  let kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = [lines[i] as string, ...kept]
    if (tok.count(marker + next.join('\n')) > cap) break
    kept = next
  }
  if (!kept.length) {
    // one enormous line: keep its end
    let lo = 0
    let hi = text.length
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (tok.count(marker + text.slice(text.length - mid)) <= cap) lo = mid
      else hi = mid - 1
    }
    return marker + text.slice(text.length - lo)
  }
  return marker + kept.join('\n')
}

const proposalSchema = z.object({
  kind: z.enum(['decision', 'thread', 'progress']),
  block: z.string().trim().min(1).optional(),
  payload: z.record(z.string(), z.unknown()),
})
const outputSchema = z.object({
  summary: z.string(),
  proposals: z.array(z.unknown()).optional(),
})

/** JSON text of a model reply: bare, fenced, or surrounded by chatter. */
export function extractJson(text: string): string | null {
  const t = text.trim()
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(t)
  const body = fence ? (fence[1] as string).trim() : t
  if (body.startsWith('{') && body.endsWith('}')) return body
  const a = body.indexOf('{')
  const b = body.lastIndexOf('}')
  return a >= 0 && b > a ? body.slice(a, b + 1) : null
}

const PROGRESS_KINDS = ['done', 'blocked', 'found', 'changed', 'question']
const STANDING = ['never', 'always', 'prefer']

/** Validate one proposal's payload for its kind; undefined = malformed. */
function cleanPayload(kind: ProposalKindOut, p: Record<string, unknown>) {
  const s = (k: string) => (typeof p[k] === 'string' && p[k].trim() ? p[k].trim() : undefined)
  if (kind === 'decision') {
    const title = s('title')
    const decision = s('decision')
    if (!title || !decision) return undefined
    const standing = s('standing')
    return {
      title,
      decision,
      ...(s('rationale') ? { rationale: s('rationale') } : {}),
      ...(standing && STANDING.includes(standing) ? { standing } : {}),
    }
  }
  if (kind === 'thread') {
    const title = s('title')
    if (!title) return undefined
    return { title, ...(s('text') ? { text: s('text') } : {}) }
  }
  const text = s('text')
  const k = s('kind') ?? 'found'
  if (!text || !PROGRESS_KINDS.includes(k)) return undefined
  return { kind: k, text }
}

export function parseCondenserReply(
  text: string,
  caps: { capTokens: number; previous: string; hadTurns: boolean },
  tok: Tokenizer,
): Omit<CondenseOutput, 'usage'> {
  const json = extractJson(text)
  if (!json) throw new CondenseError('reply contains no JSON object')
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (e) {
    throw new CondenseError(`reply is not valid JSON: ${(e as Error).message}`)
  }
  const out = outputSchema.safeParse(raw)
  if (!out.success) throw new CondenseError('reply lacks a string "summary"')
  let summary = out.data.summary.trim()
  if (!summary && caps.previous.trim() && caps.hadTurns)
    throw new CondenseError('reply has an empty summary; refusing to drop the previous one')
  let truncated = false
  if (tok.count(summary) > caps.capTokens) {
    summary = truncateSummary(summary, caps.capTokens, tok)
    truncated = true
  }
  const proposals: CondenseProposal[] = []
  let dropped = 0
  for (const item of out.data.proposals ?? []) {
    const p = proposalSchema.safeParse(item)
    const payload = p.success ? cleanPayload(p.data.kind, p.data.payload) : undefined
    if (!p.success || !payload || proposals.length >= MAX_PROPOSALS) {
      dropped++
      continue
    }
    proposals.push({
      kind: p.data.kind,
      ...(p.data.block ? { block: p.data.block } : {}),
      payload,
    })
  }
  return { summary, proposals, truncated, dropped }
}

export class Condenser {
  constructor(
    private readonly provider: LLMProvider,
    private readonly tok: Tokenizer,
    private readonly maxTokens = 2500,
  ) {}

  /** Throws CondenseError (or the provider's LLMError) on failure; nothing is mutated. */
  async run(input: CondenseInput, signal?: AbortSignal): Promise<CondenseOutput> {
    const res = await this.provider.complete(
      {
        system: CONDENSER_SYSTEM,
        prompt: condenserPrompt(input),
        maxTokens: Math.max(this.maxTokens, input.capTokens + 1000),
        json: true,
      },
      signal,
    )
    const parsed = parseCondenserReply(
      res.text,
      { capTokens: input.capTokens, previous: input.previous, hadTurns: input.turns.length > 0 },
      this.tok,
    )
    return { ...parsed, usage: res.usage }
  }
}
