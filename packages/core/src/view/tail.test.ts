// Tail policy: stubbing, never-touch invariants, condensation slice, assembly order.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config/load.js'
import { estimatorTokenizer } from '../tokenizer.js'
import {
  assemble,
  type Conversation,
  formatTokens,
  shapeTail,
  type TailPolicy,
  type Turn,
  tailPolicy,
} from './tail.js'

const policy = tailPolicy(loadConfig())
const big = (n: number) => 'x'.repeat(n * 4) // n estimator tokens

/** `rounds` exchanges of user → assistant → tool → assistant, then a newest user turn. */
function convo(rounds: number, toolTokens = 500): Conversation {
  const turns: Turn[] = []
  for (let i = 0; i < rounds; i++)
    turns.push(
      { role: 'user', content: `question ${i}` },
      { role: 'assistant', content: `calling a tool for ${i}` },
      { role: 'tool', content: big(toolTokens), toolName: i % 2 ? 'Bash' : 'Read', id: `t${i}` },
      { role: 'assistant', content: `answer ${i}` },
    )
  turns.push({ role: 'user', content: 'newest question' })
  return { system: 'host prompt', turns }
}

const shape = (c: Conversation, window = 1_000_000, p: TailPolicy = policy) =>
  shapeTail(c, { policy: p, window, tokenizer: estimatorTokenizer })

describe('shapeTail', () => {
  it('reads its policy from tail.yaml', () => {
    expect(policy).toEqual({
      budgetShareOfWindow: 0.35,
      toolResultMaxAgeTurns: 6,
      stubTemplate: '[elided: {tokens} tokens — {tool}]',
      neverStub: ['user'],
      sliceMinTurns: 6,
    })
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(4213)).toBe('4.2k')
    expect(formatTokens(2000)).toBe('2k')
  })

  it('stubs tool results older than the max age in user turns, with size and tool name', () => {
    const c = convo(10, 4213)
    const r = shape(c)
    // tool turn of round i is followed by (10 - i) user turns; stub when > 6, i.e. rounds 0..3
    expect(r.stubbed).toEqual([2, 6, 10, 14])
    expect(r.conversation.turns[2]?.content).toBe('[elided: 4.2k tokens — Read]')
    expect(r.conversation.turns[6]?.content).toBe('[elided: 4.2k tokens — Bash]')
    expect(r.conversation.turns[18]?.content).toBe(c.turns[18]?.content)
    expect(r.conversation.turns[2]?.id).toBe('t0')
    // idempotent: shaping a shaped conversation changes nothing more
    expect(shape(r.conversation).conversation).toEqual(r.conversation)
  })

  it('never alters user turns, the newest turn, or the input conversation', () => {
    const c = convo(10)
    c.turns.push({ role: 'tool', content: big(900), toolName: 'Bash' }) // newest turn is a tool result
    const frozen = structuredClone(c)
    const r = shape(c)
    expect(c).toEqual(frozen)
    r.conversation.turns.forEach((t, i) => {
      if (t.role === 'user') expect(t).toBe(c.turns[i])
    })
    expect(r.conversation.turns.at(-1)).toBe(c.turns.at(-1))
    expect(r.conversation.system).toBe(c.system)
  })

  it('reports no condensation while within budget', () => {
    const r = shape(convo(3))
    expect(r.overBudget).toBe(false)
    expect(r.condense).toBeUndefined()
    expect(r.budget).toBe(350000)
  })

  it('picks the smallest oldest slice that fits, ending before a user turn', () => {
    const c = convo(10, 500) // ~10 × 510 tokens of recent tool output, old ones stubbed
    const r = shape(c, 8000) // budget 2800
    expect(r.overBudget).toBe(true)
    const { fromIndex, toIndex } = r.condense as { fromIndex: number; toIndex: number }
    expect(fromIndex).toBe(0)
    expect(toIndex + 1).toBeGreaterThanOrEqual(policy.sliceMinTurns)
    expect(r.conversation.turns[toIndex + 1]?.role).toBe('user')
    const remaining = r.conversation.turns
      .slice(toIndex + 1)
      .reduce((n, t) => n + estimatorTokenizer.count(t.content), 0)
    expect(remaining).toBeLessThanOrEqual(r.budget)
    // the previous boundary would not have been enough
    const prev = r.conversation.turns
      .slice(toIndex - 3)
      .reduce((n, t) => n + estimatorTokenizer.count(t.content), 0)
    expect(prev).toBeGreaterThan(r.budget)
  })

  it('takes the largest allowed slice when nothing fits, never the newest user turn', () => {
    const c = convo(4, 500)
    c.turns.push({ role: 'assistant', content: big(5000) })
    c.turns.push({ role: 'user', content: 'really the newest' })
    const r = shape(c, 1000)
    const newestUser = c.turns.length - 1
    expect(r.condense).toEqual({ fromIndex: 0, toIndex: newestUser - 1 })
    expect((r.condense?.toIndex ?? 99) < newestUser).toBe(true)
  })

  it('offers no slice when there are too few turns before the newest user turn', () => {
    const c: Conversation = {
      system: '',
      turns: [
        { role: 'user', content: big(100) },
        { role: 'assistant', content: big(100) },
        { role: 'user', content: 'newest' },
      ],
    }
    const r = shape(c, 100)
    expect(r.overBudget).toBe(true)
    expect(r.condense).toBeUndefined()
  })
})

describe('assemble', () => {
  it('orders system+envelope+floor, unfiled, tail, delta, newest user turn', () => {
    const tail: Conversation = {
      system: 'host prompt',
      turns: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'tool', content: 'out', toolName: 'Bash' },
        { role: 'user', content: 'newest' },
      ],
    }
    const out = assemble({
      envelope: '<hafiz hash="abc" role="worker">\nview\n</hafiz>',
      floor: '<hafiz-floor>\nfloor\n</hafiz-floor>',
      unfiled: 'we were halfway through the webhook design',
      tail,
      delta: '<hafiz-delta>\nSince your last view:\n- x\n</hafiz-delta>',
    })
    expect(out.system).toBe(
      'host prompt\n\n<hafiz hash="abc" role="worker">\nview\n</hafiz>\n\n<hafiz-floor>\nfloor\n</hafiz-floor>',
    )
    expect(out.turns.map((t) => t.id ?? t.content)).toEqual([
      'hafiz-unfiled',
      'q1',
      'a1',
      'out',
      'hafiz-delta',
      'newest',
    ])
    expect(out.turns[0]?.content).toContain('we were halfway through the webhook design')
    expect(out.turns.at(-1)).toBe(tail.turns.at(-1))
    expect(tail.turns).toHaveLength(4) // input untouched
  })

  it('omits empty parts', () => {
    const tail: Conversation = { system: '', turns: [{ role: 'user', content: 'hi' }] }
    const out = assemble({ envelope: '<hafiz/>', floor: '', tail, delta: '' })
    expect(out).toEqual({ system: '<hafiz/>', turns: [{ role: 'user', content: 'hi' }] })
  })
})
