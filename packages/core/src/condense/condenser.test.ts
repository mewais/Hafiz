import { describe, expect, it } from 'vitest'
import { Core } from '../commands/core.js'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import type { Actor } from '../domain/types.js'
import { FakeProvider } from '../llm/providers.js'
import { MemoryBackend } from '../store/memory.js'
import { estimatorTokenizer as tok } from '../tokenizer.js'
import {
  CONDENSER_SYSTEM,
  condenserPrompt,
  parseCondenserReply,
  truncateSummary,
} from './condenser.js'

const caps = { capTokens: 100, previous: '', hadTurns: true }
const reply = (o: unknown) => JSON.stringify(o)

describe('condenser reply parsing', () => {
  it('accepts bare, fenced and chatty JSON', () => {
    const body = reply({ summary: 'user wants X', proposals: [] })
    for (const text of [
      body,
      `\`\`\`json\n${body}\n\`\`\``,
      `Sure! Here you go:\n${body}\nHope it helps`,
    ])
      expect(parseCondenserReply(text, caps, tok).summary).toBe('user wants X')
  })

  it('keeps well-formed proposals, drops malformed ones, caps the count', () => {
    const out = parseCondenserReply(
      reply({
        summary: 's',
        proposals: [
          {
            kind: 'decision',
            payload: {
              title: 'Use cents',
              decision: 'Money is integer cents.',
              standing: 'always',
            },
          },
          { kind: 'decision', payload: { title: 'no decision text' } },
          { kind: 'thread', block: 'blk_x', payload: { title: 'Rounding', text: 'unclear' } },
          { kind: 'progress', payload: { kind: 'bogus', text: 'x' } },
          { kind: 'progress', payload: { text: 'found the bug' } },
          { kind: 'nonsense', payload: {} },
          'garbage',
        ],
      }),
      caps,
      tok,
    )
    expect(out.proposals.map((p) => p.kind)).toEqual(['decision', 'thread', 'progress'])
    expect(out.proposals[0]?.payload).toEqual({
      title: 'Use cents',
      decision: 'Money is integer cents.',
      standing: 'always',
    })
    expect(out.proposals[1]?.block).toBe('blk_x')
    expect(out.proposals[2]?.payload).toEqual({ kind: 'found', text: 'found the bug' })
    expect(out.dropped).toBe(4)
  })

  it.each([
    ['prose', 'I could not do that.'],
    ['broken json', '{"summary": "x", '],
    ['wrong shape', '{"text": "x"}'],
    ['non-string summary', '{"summary": 3}'],
  ])('rejects %s', (_n, text) => {
    expect(() => parseCondenserReply(text, caps, tok)).toThrow()
  })

  it('refuses an empty summary that would drop a previous one', () => {
    expect(() =>
      parseCondenserReply(reply({ summary: '' }), { ...caps, previous: 'old' }, tok),
    ).toThrow(/previous/)
    expect(parseCondenserReply(reply({ summary: '' }), caps, tok).summary).toBe('')
  })

  it('truncates an over-cap summary to the cap, newest lines kept', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'word '.repeat(10)}`)
    const out = parseCondenserReply(reply({ summary: lines.join('\n') }), caps, tok)
    expect(out.truncated).toBe(true)
    expect(tok.count(out.summary)).toBeLessThanOrEqual(100)
    expect(out.summary.startsWith('[older context trimmed]')).toBe(true)
    expect(out.summary).toContain('line 199')
    expect(out.summary).not.toContain('line 0 ')
    expect(tok.count(truncateSummary('x'.repeat(5000), 50, tok))).toBeLessThanOrEqual(50)
  })
})

describe('condenser prompt', () => {
  it('carries previous summary, envelope as excluded context, and numbered turns', () => {
    const p = condenserPrompt({
      previous: 'earlier note',
      envelope: '<hafiz hash="x">design</hafiz>',
      turns: [
        { role: 'user', content: 'please do X' },
        { role: 'tool', content: 'y'.repeat(5000), toolName: 'read' },
      ],
      focus: [],
      capTokens: 1500,
    })
    expect(p).toContain('<previous_summary>\nearlier note\n</previous_summary>')
    expect(p).toContain('<envelope>\n<hafiz hash="x">design</hafiz>\n</envelope>')
    expect(p).toContain('[user #1] please do X')
    expect(p).toMatch(/\[tool read #2\] y+\n\[… \d+ characters omitted …\]\ny+/)
    expect(p).toContain('1500')
    expect(CONDENSER_SYSTEM).toContain('ALREADY COVERED')
    expect(CONDENSER_SYSTEM).toContain('ONLY something the USER actually decided')
  })
})

const mgr: Actor = { sessionId: 'm1', role: 'manager' }

async function setup(provider: FakeProvider, condenser = 'fake') {
  const config = loadConfig()
  config.hafiz.llm.condenser.provider = condenser
  const core = new Core({
    config,
    backend: new MemoryBackend(),
    clock: fixedClock(),
    llm: { condenser: provider },
  })
  const { result: init } = await core.projectInit(mgr, { name: 'Shop', originFingerprint: 'fp' })
  const block = init.root.id
  await core.sessionOpen({ id: 's', host: 'test', role: 'manager' })
  await core.focusSet({ sessionId: 's', role: 'manager' }, { blocks: [block] })
  return { core, block }
}

const turns = [
  { role: 'user', content: 'lets use integer cents everywhere' },
  { role: 'assistant', content: 'ok' },
]
const through = { index: 1, fingerprint: 'abc' }

describe('Core.sessionCondense', () => {
  it('stores summary and cursor, queues proposals as condenser source, counts the cost', async () => {
    const fake = new FakeProvider('fake', () => ({
      summary: 'User: integer cents everywhere.',
      proposals: [
        { kind: 'decision', payload: { title: 'Cents', decision: 'Money is integer cents.' } },
        { kind: 'thread', block: 'blk_missing', payload: { title: 'Lost' } },
      ],
    }))
    const { core, block } = await setup(fake)
    const r = await core.sessionCondense('s', { turns, through })
    expect(r).toMatchObject({ status: 'condensed', proposals: 1 })
    expect(r.notices.map((n) => n.text).join()).toContain('no valid block')
    const s = await core.backend.read.getSession('s')
    expect(s?.unfiledSummary).toBe('User: integer cents everywhere.')
    expect(s?.condensed).toEqual(through)
    expect(s?.counters.condensations).toBe(1)
    expect(
      (s?.counters.condense_tokens_in ?? 0) > 0 && (s?.counters.condense_tokens_out ?? 0) > 0,
    ).toBe(true)
    const [p] = await core.backend.read.listProposals({ status: 'pending' })
    expect(p).toMatchObject({ kind: 'decision', source: 'condenser', blockId: block })
    expect(p?.payload).toMatchObject({
      command: 'decision.record',
      args: { block, title: 'Cents' },
    })
    // the request carried the envelope as excluded context
    expect(fake.requests[0]?.prompt).toContain('<envelope>')
    // accepting performs the decision
    await core.proposalResolve(
      { sessionId: 'u', role: 'user' },
      { id: p?.id as string, accept: true },
    )
    expect(await core.backend.read.readLog(block, 'decisions')).toHaveLength(1)
  })

  it('malformed output: previous summary and cursor kept, a warn notice, no proposals', async () => {
    const replies = [
      { summary: 'first', proposals: [] },
      'this is not json at all',
      { summary: '', proposals: [] },
    ]
    const fake = new FakeProvider('fake', (_r, n) => replies[n - 1])
    const { core } = await setup(fake)
    await core.sessionCondense('s', { turns, through })
    await core.checkpointRequest('s')
    for (const [i, fp] of ['x', 'y'].entries()) {
      const r = await core.sessionCondense('s', {
        turns,
        through: { index: 5 + i, fingerprint: fp },
      })
      expect(r.status).toBe('failed')
      expect(r.notices[0]).toMatchObject({ level: 'warn' })
      expect(r.notices[0]?.text).toContain('keeping the previous summary')
      const s = await core.backend.read.getSession('s')
      expect(s?.unfiledSummary).toBe('first')
      expect(s?.condensed).toEqual(through)
      expect(s?.checkpointRequested).toBeUndefined()
      expect(s?.counters.condense_failures).toBe(i + 1)
    }
    expect(await core.backend.read.listProposals()).toEqual([])
  })

  it('provider errors are failures too', async () => {
    const boom = new FakeProvider('fake', () => {
      throw new Error('503')
    })
    const { core } = await setup(boom)
    expect((await core.sessionCondense('s', { turns, through })).status).toBe('failed')
  })

  it('an unconfigured core does not condense', async () => {
    const core = new Core({ config: loadConfig(), backend: new MemoryBackend() })
    expect(core.condenserEnabled).toBe(false)
    await core.projectInit(mgr, { name: 'Shop', originFingerprint: 'fp' })
    await core.sessionOpen({ id: 's', host: 'test', role: 'manager' })
    expect((await core.sessionCondense('s', { turns, through })).status).toBe('skipped')
  })
})
