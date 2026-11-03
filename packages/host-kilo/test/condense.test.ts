// M5 exit scenario: a scripted 200-turn session through the real shaper, daemon and (fake)
// condenser. The host's own compaction is never needed, the unfiled summary stays under its cap,
// condensed turns leave the tail deterministically, and proposals appear for protocol calls the
// agent deliberately never made.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import {
  type Config,
  type Conversation,
  FakeProvider,
  loadConfig,
  resolveProject,
  type Turn,
  estimatorTokenizer as tok,
} from '@hafiz/core'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConversationShaper,
  locateCursor,
  SessionRegistry,
  USER_TURN_COUNTERS,
} from '../src/index.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

const WINDOW = 20_000

async function rig(provider: string, llm?: FakeProvider) {
  const cwd = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const io: Io = { cwd, env, out: () => undefined, err: () => undefined }
  expect(await run(['init', 'Shop'], io)).toBe(0)
  const config: Config = loadConfig()
  config.hafiz.llm.condenser.provider = provider
  config.hafiz.windows.default = WINDOW
  const d: DaemonHandle = await startDaemon({
    projectDir: cwd,
    env,
    idleShutdownMs: 0,
    config,
    ...(llm ? { llm: { condenser: llm } } : {}),
  })
  cleanup.push(() => d.close())
  const log: string[] = []
  const sessions = new SessionRegistry({
    project: resolveProject(cwd, env),
    config,
    connect: () => DaemonClient.connect(d.socketPath),
    log: (l) => log.push(l),
  })
  cleanup.push(() => sessions.close())
  const shaper = new ConversationShaper({ config, source: sessions, log: (l) => log.push(l) })
  expect(await sessions.open('ses', { agent: 'manager' })).toBe(true)
  const root = (await d.service.core.treeListRaw())[0]?.id as string
  await d.service.core.focusSet({ sessionId: 'ses', role: 'user' }, { blocks: [root] })
  return { d, sessions, shaper, config, log, root }
}

/** The assembled request, as the wire adapters would send it. */
async function request(r: Awaited<ReturnType<typeof rig>>, conversation: Conversation) {
  const shaped = await r.shaper.shape({ sessionId: 'ses', model: 'm', conversation })
  if (!shaped) throw new Error('unmanaged')
  const text = `${shaped.systemAddition}\n${JSON.stringify(shaped.turns)}`
  return {
    shaped,
    text,
    tokens:
      tok.count(shaped.systemAddition) + shaped.turns.reduce((n, t) => n + tok.count(t.content), 0),
  }
}

/** One exchange: user ask, assistant reply with a big tool call, assistant wrap-up. */
function exchange(i: number): Turn[] {
  return [
    {
      role: 'user',
      content: `Step ${i}: please adjust module ${i % 7} so that case ${i} rounds to cents. ${'Context. '.repeat(20)}`,
      id: `u${i}`,
    },
    { role: 'assistant', content: `Looking at module ${i % 7}.`, id: `a${i}` },
    {
      role: 'tool',
      toolName: 'read',
      content: `// module ${i % 7}\n${'const x = 1 // filler line\n'.repeat(170)}`,
      id: `t${i}`,
    },
    { role: 'assistant', content: `Done with step ${i}; tests pass.`, id: `b${i}` },
  ]
}

describe('condenser in the loop (M5 exit)', () => {
  it('200 turns: no host compaction needed, summary under cap, deterministic, proposals queued', async () => {
    const fake = new FakeProvider('fake', (_req, n) =>
      n === 2
        ? {
            summary: 'User is walking modules to round to cents.',
            proposals: [
              {
                kind: 'decision',
                payload: {
                  title: 'Round at the boundary',
                  decision: 'Round to cents when crossing the API boundary.',
                },
              },
              {
                kind: 'thread',
                payload: {
                  title: 'Module 3 rounding',
                  text: 'Unclear whether banker rounding applies.',
                },
              },
              {
                kind: 'progress',
                payload: { kind: 'done', text: 'Modules 0-6 adjusted to round to cents.' },
              },
            ],
          }
        : undefined,
    )
    const r = await rig('fake', fake)
    const cap = r.config.tail.unfiled.cap_tokens
    const conv: Conversation = { system: 'host prompt', turns: [] }
    let rawTokens = 0
    let maxRequest = 0
    let lastCovered = 0
    for (let i = 0; i < 50; i++) {
      for (const t of exchange(i)) {
        conv.turns.push(t)
        rawTokens += tok.count(t.content)
      }
      await r.sessions.counters('ses', USER_TURN_COUNTERS)
      const { shaped, tokens } = await request(r, conv)
      await r.shaper.idle() // the next request arrives after the condensation finished
      maxRequest = Math.max(maxRequest, tokens)
      // the cut only ever moves forward
      expect(shaped.covered).toBeGreaterThanOrEqual(lastCovered)
      lastCovered = shaped.covered
    }
    expect(r.log.filter((l) => /fail/i.test(l))).toEqual([])
    // 200 turns (50 exchanges × 4) overflow the window many times over; the request never does
    expect(conv.turns).toHaveLength(200)
    expect(rawTokens).toBeGreaterThan(WINDOW * 2)
    expect(maxRequest).toBeLessThan(WINDOW)

    const s = await r.d.service.core.backend.read.getSession('ses')
    expect(s?.counters.condensations).toBeGreaterThan(2)
    expect(s?.counters.view_emits).toBeGreaterThanOrEqual(1)
    expect(tok.count(s?.unfiledSummary ?? '')).toBeLessThanOrEqual(cap)
    expect(s?.unfiledSummary?.length).toBeGreaterThan(0)

    // condensed turns left the tail; the cut is where the cursor says
    const final = await request(r, conv)
    expect(final.shaped.covered).toBeGreaterThan(100)
    expect(locateCursor(conv.turns, s?.condensed) + 1).toBe(final.shaped.covered)
    expect(final.shaped.turns.some((t) => t.id === 'u0')).toBe(false)
    expect(final.shaped.turns.some((t) => t.id === 'u49')).toBe(true)
    expect(final.shaped.turns[0]?.id).toBe('hafiz-unfiled')

    // two consecutive shapes of the same conversation: identical bytes
    const again = await request(r, conv)
    expect(again.text).toBe(final.text)

    // proposals for protocol calls the agent never made
    const props = await r.d.service.core.backend.read.listProposals({ status: 'pending' })
    const mine = props.filter((p) => p.source === 'condenser')
    expect(mine.map((p) => p.kind).sort()).toEqual(['decision', 'progress', 'thread'])
    expect(mine.every((p) => p.blockId === r.root && p.note?.startsWith('condenser:'))).toBe(true)
  })

  it('condensation does not block the request that triggered it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const slow = new FakeProvider('fake')
    const orig = slow.complete.bind(slow)
    slow.complete = async (q, s) => {
      await gate
      return orig(q, s)
    }
    const r = await rig('fake', slow)
    const conv: Conversation = { system: '', turns: [] }
    let started: unknown
    for (let i = 0; i < 40 && !started; i++) {
      conv.turns.push(...exchange(i))
      started = (await request(r, conv)).shaped.condense
    }
    expect(started).toBeTruthy() // returned while the provider was still waiting
    const before = (await request(r, conv)).shaped
    expect(before.covered).toBe(0)
    expect(before.condense).toBeUndefined() // one in flight per session
    release()
    await r.shaper.idle()
    expect((await request(r, conv)).shaped.covered).toBeGreaterThan(0)
  })

  it('a failed condensation keeps every turn and records a notice', async () => {
    const r = await rig('fake', new FakeProvider('fake', () => 'sorry, no JSON today'))
    const conv: Conversation = { system: '', turns: [] }
    for (let i = 0; i < 40; i++) {
      conv.turns.push(...exchange(i))
      await request(r, conv)
      await r.shaper.idle()
    }
    const s = await r.d.service.core.backend.read.getSession('ses')
    expect(s?.unfiledSummary).toBeUndefined()
    expect(s?.condensed).toBeUndefined()
    expect(s?.counters.condense_failures).toBeGreaterThan(0)
    const { shaped } = await request(r, conv)
    expect(shaped.covered).toBe(0)
    expect(shaped.turns.filter((t) => t.id?.startsWith('u'))).toHaveLength(40)
    // the notice reaches the session through the tail
    expect(shaped.turns.map((t) => t.content).join('\n')).toContain('keeping the previous summary')
  })

  it('provider none: no condensation, the tail only grows (host compaction stays on)', async () => {
    const r = await rig('none')
    const conv: Conversation = { system: '', turns: [] }
    let over = false
    for (let i = 0; i < 40; i++) {
      conv.turns.push(...exchange(i))
      const { shaped } = await request(r, conv)
      expect(shaped.condense).toBeUndefined()
      expect(shaped.covered).toBe(0)
      over ||= shaped.turns.length >= conv.turns.length
    }
    expect(over).toBe(true)
    const s = await r.d.service.core.backend.read.getSession('ses')
    expect(s?.counters.condensations).toBeUndefined()
  })

  it('checkpoint forces a condensation of a small conversation', async () => {
    const fake = new FakeProvider('fake')
    const r = await rig('fake', fake)
    const conv: Conversation = { system: '', turns: [] }
    for (let i = 0; i < 3; i++) conv.turns.push(...exchange(i))
    expect((await request(r, conv)).shaped.condense).toBeUndefined() // well under budget
    // `hafiz checkpoint` through the daemon, as the CLI does
    const cli = await DaemonClient.connect(r.d.socketPath)
    cleanup.push(() => cli.close())
    await cli.openSession({ id: 'cli', host: 'cli', role: 'user' })
    expect(await cli.call('checkpoint.request', { session: '*' })).toEqual({ requested: ['ses'] })
    const first = (await request(r, conv)).shaped
    expect(first.condense).toEqual({ fromIndex: 0, toIndex: 7 }) // everything before the newest user turn
    await r.shaper.idle()
    const after = (await request(r, conv)).shaped
    expect(after.covered).toBe(8)
    expect(after.turns.map((t) => t.id)).toEqual(['hafiz-unfiled', 'u2', 'a2', 't2', 'b2'])
    expect(
      (await r.d.service.core.backend.read.getSession('ses'))?.checkpointRequested,
    ).toBeUndefined()
  })
})
