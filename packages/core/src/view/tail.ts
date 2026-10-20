// Tail policy over a host-neutral conversation model (§6.5). Pure: no LLM, no I/O.
// shapeTail stubs old tool results and decides whether (and which slice) to condense;
// assemble builds the final request: system + envelope + floor, unfiled, tail, delta, newest turn.
import type { Config } from '../config/schema.js'
import type { Tokenizer } from '../tokenizer.js'

export type TurnRole = 'user' | 'assistant' | 'tool'

export interface Turn {
  role: TurnRole
  content: string
  toolName?: string
  id?: string
}

export interface Conversation {
  system: string
  turns: Turn[]
}

export interface TailPolicy {
  budgetShareOfWindow: number
  toolResultMaxAgeTurns: number
  stubTemplate: string
  neverStub: readonly string[]
  sliceMinTurns: number
}

export function tailPolicy(config: Pick<Config, 'tail'>): TailPolicy {
  const t = config.tail
  return {
    budgetShareOfWindow: t.tail.budget_share_of_window,
    toolResultMaxAgeTurns: t.tail.tool_result_max_age_turns,
    stubTemplate: t.tail.stub_template,
    neverStub: t.tail.never_stub,
    sliceMinTurns: t.condensation.slice_min_turns,
  }
}

export interface ShapeOptions {
  policy: TailPolicy
  window: number
  tokenizer: Tokenizer
}

export interface ShapeResult {
  conversation: Conversation
  /** Indices of turns replaced by a stub. */
  stubbed: number[]
  tokens: number
  budget: number
  overBudget: boolean
  /** Inclusive turn range the condenser should fold into the unfiled summary. */
  condense?: { fromIndex: number; toIndex: number }
}

/** `4213` → `4.2k`; small counts stay exact. */
export function formatTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export function stubFor(template: string, tokens: number, tool: string): string {
  return template.replace('{tokens}', formatTokens(tokens)).replace('{tool}', tool)
}

export function shapeTail(conv: Conversation, opts: ShapeOptions): ShapeResult {
  const { policy, tokenizer } = opts
  const turns = conv.turns
  const last = turns.length - 1
  const stubPrefix = policy.stubTemplate.split('{')[0] ?? ''
  // user turns strictly after each index
  const userAfter: number[] = new Array(turns.length).fill(0)
  for (let i = last - 1, n = 0; i >= 0; i--) {
    if ((turns[i + 1] as Turn).role === 'user') n++
    userAfter[i] = n
  }
  const stubbed: number[] = []
  const out: Turn[] = turns.map((t, i) => {
    if (t.role !== 'tool' || i === last || policy.neverStub.includes(t.role)) return t
    if ((userAfter[i] as number) <= policy.toolResultMaxAgeTurns) return t
    if (stubPrefix && t.content.startsWith(stubPrefix)) return t // already a stub
    stubbed.push(i)
    return {
      ...t,
      content: stubFor(policy.stubTemplate, tokenizer.count(t.content), t.toolName ?? 'tool'),
    }
  })
  const sizes = out.map((t) => tokenizer.count(t.content))
  const tokens = sizes.reduce((a, b) => a + b, 0)
  const budget = Math.round(policy.budgetShareOfWindow * opts.window)
  const conversation = { system: conv.system, turns: out }
  if (tokens <= budget) return { conversation, stubbed, tokens, budget, overBudget: false }

  // Oldest slice ending on a turn boundary (the next turn is a user turn), at least
  // slice_min_turns long, never reaching the newest user turn. Smallest slice that brings the
  // remainder within budget; otherwise the largest allowed.
  let newestUser = -1
  for (let i = last; i >= 0; i--)
    if ((out[i] as Turn).role === 'user') {
      newestUser = i
      break
    }
  let condense: ShapeResult['condense']
  let removed = 0
  for (let t = 0; t + 1 <= newestUser; t++) {
    removed += sizes[t] as number
    if ((out[t + 1] as Turn).role !== 'user' || t + 1 < policy.sliceMinTurns) continue
    condense = { fromIndex: 0, toIndex: t }
    if (tokens - removed <= budget) break
  }
  return {
    conversation,
    stubbed,
    tokens,
    budget,
    overBudget: true,
    ...(condense ? { condense } : {}),
  }
}

export interface AssembleInput {
  /** `<hafiz …>` envelope from context.for. */
  envelope: string
  floor?: string
  /** Rolling unfiled summary from the condenser. */
  unfiled?: string
  tail: Conversation
  /** `<hafiz-delta>` block from context.delta. */
  delta?: string
}

/**
 * Final request per §6.5:
 *   system: host prompt + envelope + floor
 *   [unfiled context] → verbatim tail → [delta] → newest user turn (never touched)
 */
export function assemble(input: AssembleInput): Conversation {
  const system = [input.tail.system, input.envelope, input.floor]
    .filter((s): s is string => !!s?.trim())
    .join('\n\n')
  const turns = [...input.tail.turns]
  if (input.delta?.trim()) {
    let newestUser = -1
    for (let i = turns.length - 1; i >= 0; i--)
      if ((turns[i] as Turn).role === 'user') {
        newestUser = i
        break
      }
    const turn: Turn = { role: 'user', content: input.delta, id: 'hafiz-delta' }
    if (newestUser < 0) turns.push(turn)
    else turns.splice(newestUser, 0, turn)
  }
  if (input.unfiled?.trim())
    turns.unshift({
      role: 'user',
      content: `<hafiz-unfiled>\nEarlier in this session (condensed):\n${input.unfiled.trim()}\n</hafiz-unfiled>`,
      id: 'hafiz-unfiled',
    })
  return { system, turns }
}
