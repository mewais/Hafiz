// Real Kilo, real TUI: the Kilo TUI runs in a pseudo-terminal (a detached tmux pane of a fixed
// size) with the mock LLM and both halves of hafiz-kilo loaded from dist; a captured
// frame must show the Hafiz sidebar and the /hafiz route. A second test routes the condenser
// through Kilo (`llm.condenser.provider: kilo`) and checks that the child session it creates is
// billed into the condensed session's family in Kilo's own store. Slow and needs the Kilo CLI and
// tmux: runs only with HAFIZ_KILO_E2E=1 and HAFIZ_KILO_BIN=<path to the kilo binary>.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { type Io, run } from '@hafiz/cli'
import { resolveProject } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, readLock, startDaemon } from '@hafiz/gateway-mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type MockLlm, type RecordedRequest, type ScriptedReply, startMockLlm } from './mock-llm.js'

const BIN = process.env.HAFIZ_KILO_BIN
const hasTmux = spawnSync('tmux', ['-V']).status === 0
const enabled = process.env.HAFIZ_KILO_E2E === '1' && !!BIN && hasTmux
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const PKG = resolve(import.meta.dirname, '..', '..', 'kilo-plugin')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const CONDENSER_REPLY = JSON.stringify({
  summary: 'The user asked for invoice totals in integer cents.',
  proposals: [],
})

describe.skipIf(!enabled)('real Kilo TUI (HAFIZ_KILO_E2E=1)', () => {
  let mock: MockLlm
  let repo: string
  let home: string
  let env: NodeJS.ProcessEnv
  let daemon: DaemonHandle
  let payments: string
  let responder: (req: RecordedRequest) => ScriptedReply = () => ({ text: 'All good.' })

  beforeAll(async () => {
    repo = tmp('hafiz-tui-repo-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    home = tmp('hafiz-tui-home-')
    mkdirSync(join(home, '.config', 'kilo'), { recursive: true })
    env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      HAFIZ_STORE_ROOT: tmp('hafiz-tui-stores-'),
      XDG_RUNTIME_DIR: tmp('hafiz-tui-rt-'),
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_SHARE: '1',
      KILO_DISABLE_SESSION_INGEST: '1',
      KILO_DISABLE_AUTOUPDATE: '1',
      TERM: 'xterm-256color',
    }
    const io: Io = { cwd: repo, env, out: () => undefined, err: () => undefined }
    expect(await run(['init', 'Shop'], io)).toBe(0)
    // the condenser runs through Kilo (second test); harmless for the first
    const { storeDir } = resolveProject(repo, env)
    mkdirSync(join(storeDir, 'config'), { recursive: true })
    writeFileSync(
      join(storeDir, 'config', 'hafiz.yaml'),
      'llm:\n  condenser: { provider: kilo, model: mock/mock-model }\n',
    )
    daemon = await startDaemon({ projectDir: repo, env, idleShutdownMs: 0 })
    const u = await DaemonClient.connect(daemon.socketPath)
    await u.openSession({ id: 'cli', host: 'test', role: 'user' })
    const root = (await u.treeList())[0]?.id as string
    const mk = async (parent: string, title: string, status?: string) => {
      const { result } = await u.dispatch<{ id: string }>('block.create', { parent, title })
      if (status) await u.dispatch('block.set_status', { id: result.id, status })
      return result.id
    }
    await mk(root, 'Auth', 'active')
    const billing = await mk(root, 'Billing', 'active')
    payments = await mk(billing, 'Payments', 'active')
    await u.dispatch('doc.write', {
      block: payments,
      type: 'plan',
      sections: {
        steps: [
          { id: 's1', title: 'Model' },
          { id: 's2', title: 'Webhooks' },
          { id: 's3', title: 'Refunds' },
        ],
        acceptance: ['charges succeed'],
      },
    })
    await u.dispatch('progress.append', {
      block: payments,
      kind: 'done',
      text: 'Model done.',
      step: { id: 's1', status: 'done' },
    })
    const reporting = await mk(root, 'Reporting')
    u.close()
    // a designer session writes Reporting's design and ends: one review in the queue
    const ds = await DaemonClient.connect(daemon.socketPath)
    await ds.openSession({ id: 'ds1', host: 'test', role: 'designer', spawnedBlock: reporting })
    await ds.dispatch('doc.patch', {
      block: reporting,
      type: 'design',
      sections: {
        purpose: 'monthly sales',
        scope: ['in: csv export'],
        interface: { provides: [{ name: 'report()' }] },
      },
    })
    await ds.sessionEnd()
    ds.close()
    mock = await startMockLlm({ fallback: (req) => responder(req) })
    // The TUI half is registered the way `hafiz install kilo --global` does: tui.json.
    writeFileSync(join(home, '.config', 'kilo', 'tui.json'), JSON.stringify({ plugin: [PKG] }))
  }, 60000)

  afterAll(async () => {
    spawnSync('tmux', ['kill-server'], { env })
    await mock?.close()
    await daemon?.close()
  })

  function kiloConfig() {
    return {
      provider: {
        mock: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Mock',
          options: { baseURL: `${mock.url}/v1`, apiKey: 'sk-test' },
          models: {
            'mock-model': {
              name: 'Mock',
              tool_call: true,
              limit: { context: 100000, output: 4000 },
              cost: { input: 3, output: 15 },
            },
          },
        },
      },
      model: 'mock/mock-model',
      small_model: 'mock/mock-model',
      plugin: [PKG],
      autoupdate: false,
      share: 'disabled',
    }
  }

  /** Start the TUI in a detached tmux pane; returns a frame grabber. */
  function tui(args: string[], cwd = repo) {
    const script = join(home, 'run-kilo.sh')
    const vars = { ...env, PWD: cwd, KILO_CONFIG_CONTENT: JSON.stringify(kiloConfig()) }
    const exports = Object.entries(vars)
      .filter(([k, v]) => v !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(k))
      .map(([k, v]) => `export ${k}='${String(v).replace(/'/g, `'\\''`)}'`)
      .join('\n')
    const argv = [BIN as string, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
    writeFileSync(
      script,
      `#!/bin/sh\n${exports}\ncd '${cwd}'\nexec ${argv} 2>>'${home}/kilo.err'\n`,
    )
    const r = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', 'hafiz', '-x', '180', '-y', '48', `sh ${script}`],
      { env },
    )
    expect(r.status).toBe(0)
    const frame = () =>
      spawnSync('tmux', ['capture-pane', '-p', '-t', 'hafiz'], { env, encoding: 'utf8' }).stdout ??
      ''
    const keys = (...k: string[]) => spawnSync('tmux', ['send-keys', '-t', 'hafiz', ...k], { env })
    const until = async (ok: (f: string) => boolean, ms = 60000) => {
      const end = Date.now() + ms
      let f = ''
      while (Date.now() < end) {
        f = frame()
        if (ok(f)) return f
        await sleep(500)
      }
      return f
    }
    return { frame, keys, until }
  }

  it('the sidebar shows the Hafiz tree, the /hafiz route opens, the review overlay accepts', async () => {
    responder = () => ({ text: 'All good.' })
    const t = tui(['--agent', 'manager', '--prompt', 'hello from the tui test'])
    const f1 = await t.until((f) => f.includes('manager · on') && f.includes('Payments'))
    console.log(`── TUI frame ──\n${f1}`)
    expect(f1).toContain('Hafiz · Shop')
    expect(f1).toContain('manager · on')
    expect(f1).toMatch(/◆ Shop/)
    expect(f1).toMatch(/▶ Payments\s+1\/3 steps/)
    expect(f1).toContain('review  design Reporting')
    expect(f1).toContain('? legend')
    // status chip next to the prompt: first focus block (+ the others) of this manager session
    expect(f1).toMatch(/◆ Auth \+2/)

    t.keys('/hafiz')
    await sleep(500)
    t.keys('Enter')
    const f2 = await t.until((f) => f.includes('[1 tree]'), 20000)
    console.log(`── /hafiz route ──\n${f2}`)
    expect(f2).toContain('[1 tree]')
    expect(f2).toContain('esc back')
    t.keys('Down')
    expect(await t.until((f) => /›├ ▶ Auth/.test(f), 10000)).toMatch(/›├ ▶ Auth/)
    t.keys('3')
    const f3 = await t.until((f) => f.includes('[3 decisions]'), 10000)
    expect(f3).toContain('standing (the floor every view carries)')
    t.keys('Escape')
    expect(await t.until((f) => f.includes('manager · on'), 10000)).toContain('Hafiz · Shop')

    // the review overlay: <leader>v (ctrl+x v) opens the list over the session
    t.keys('C-x')
    await sleep(200)
    t.keys('v')
    const r1 = await t.until((f) => f.includes('Hafiz review · 1 pending'), 10000)
    console.log(`── review list ──\n${r1}`)
    expect(r1).toMatch(/› design {2}Reporting v1 {2}· {2}review · \w+ {2}· {2}queue/)
    t.keys('Enter')
    const r2 = await t.until((f) => f.includes('design review · Reporting'), 10000)
    console.log(`── review detail ──\n${r2}`)
    expect(r2).toContain('Purpose: monthly sales')
    expect(r2).toContain('by designer')
    expect(r2).toContain('Open questions')
    t.keys('r')
    const r3 = await t.until((f) => f.includes('reject design · Reporting v1'), 10000)
    console.log(`── reject prompt ──\n${r3}`)
    expect(r3).toContain('Why? One or two lines.')
    // esc steps back one view at a time, typing in the prompt never triggers a/r
    t.keys('Escape')
    expect(await t.until((f) => f.includes('design review · Reporting'), 10000)).toContain(
      'd previous version',
    )
    t.keys('Escape')
    expect(await t.until((f) => f.includes('Hafiz review · 1 pending'), 10000)).toContain(
      '⏎ open · a accept',
    )
    // accept as the user: a toast, and the list redraws empty from the store
    t.keys('a')
    const r4 = await t.until((f) => f.includes('Hafiz review · 0 pending'), 10000)
    console.log(`── after accept ──\n${r4}`)
    expect(r4).toContain('nothing pending review')
    expect(r4).toContain('design Reporting v1 accepted')
    t.keys('Escape')
    expect(await t.until((f) => !f.includes('Hafiz review ·'), 10000)).not.toContain(
      'review  design Reporting',
    )

    // the keybind: <leader>f (ctrl+x f)
    t.keys('C-x')
    await sleep(200)
    t.keys('f')
    expect(await t.until((f) => f.includes('[1 tree]'), 10000)).toContain('[1 tree]')
    spawnSync('tmux', ['kill-session', '-t', 'hafiz'], { env })
  }, 150000)

  it('an untracked repo shows "untracked", then the tracked tree right after hafiz_track_project, no restart', async () => {
    const fresh = tmp('hafiz-tui-untracked-')
    execFileSync('git', ['init', '-q'], { cwd: fresh })
    const marker = 'track this multi-step build'
    const results = (r: RecordedRequest) =>
      (r.body as { messages: Array<{ role: string }> }).messages.filter((m) => m.role === 'tool')
        .length
    const hasTools = (r: RecordedRequest) =>
      ((r.body as { tools?: unknown[] }).tools ?? []).length > 0
    responder = (req) => {
      if (!req.raw.includes(marker) || !hasTools(req)) return { text: 'Title' }
      // hold the call so the untracked frame can be captured, and the answer so the tracked one
      if (results(req) === 0)
        return {
          toolCalls: [
            { name: 'hafiz_track_project', arguments: { name: 'Fresh', reason: 'Multi-step.' } },
          ],
          delayMs: 6000,
        }
      return { text: 'Tracking this repo with Hafiz as `Fresh`.', delayMs: 20000 }
    }
    const t = tui(['--agent', 'build', '--prompt', marker], fresh)
    try {
      const f1 = await t.until((f) => f.includes('Hafiz · untracked'))
      console.log(`── untracked frame ──\n${f1}`)
      expect(f1).toContain('Hafiz · untracked')
      expect(f1).toContain('starts when work turns multi-step')
      expect(f1).not.toContain('connecting')
      const f2 = await t.until(
        (f) => f.includes('Hafiz · Fresh') && !f.includes('Hafiz · untracked'),
        40000,
      )
      console.log(`── tracked frame, right after the tool completed ──\n${f2}`)
      expect(f2).toContain('Hafiz · Fresh')
      expect(f2).toMatch(/◆ Fresh/)
      expect(f2).not.toContain('Hafiz · untracked')
      // the model's follow-up is still held back: the switch came from the tool event
      expect(f2).not.toContain('Tracking this repo with Hafiz as')
    } finally {
      spawnSync('tmux', ['kill-session', '-t', 'hafiz'], { env })
      try {
        const lock = readLock(resolveProject(fresh, env).storeDir)
        if (lock) process.kill(lock.pid)
      } catch {}
    }
  }, 150000)

  it('condensation through Kilo: a child session of the condensed one, billed to its family', async () => {
    const marker = 'condense me please'
    responder = (req) => {
      if (req.raw.includes('working memory of a long coding session'))
        return { text: CONDENSER_REPLY, usage: { input: 900, output: 40 } }
      // keep the main reply waiting so the fire-and-forget condensation finishes first
      if (req.raw.includes(marker)) return { text: 'Second answer.', delayMs: 4000 }
      return { text: 'First answer.' }
    }
    const runKilo = (args: string[]) =>
      new Promise<{ code: number; output: string }>((res) => {
        const p = spawn(BIN as string, ['run', '--print-logs', '--log-level', 'WARN', ...args], {
          cwd: repo,
          env: { ...env, PWD: repo, KILO_CONFIG_CONTENT: JSON.stringify(kiloConfig()) },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let output = ''
        p.stdout?.on('data', (c) => {
          output = (output + c).slice(-4000)
        })
        p.stderr?.on('data', (c) => {
          output = (output + c).slice(-4000)
        })
        p.on('close', (code) => res({ code: code ?? -1, output }))
      })
    const first = await runKilo(['--agent', 'manager', 'please keep invoice totals in cents'])
    if (first.code !== 0) console.error(first.output)
    expect(first.code).toBe(0)
    const sessions = await daemon.service.core.backend.read.listSessions()
    const parent = sessions.filter((s) => s.host === 'kilo' && s.role === 'manager').at(-1)
    expect(parent).toBeDefined()
    const u = await DaemonClient.connect(daemon.socketPath)
    await u.openSession({ id: 'cli', host: 'test', role: 'user' })
    await u.call('checkpoint.request', { session: parent?.id })
    u.close()
    const second = await runKilo(['--agent', 'manager', '--session', parent?.id as string, marker])
    if (second.code !== 0) console.error(second.output)
    expect(second.code).toBe(0)

    // the condenser's request reached the LLM from a child of the condensed Kilo session
    const cond = mock.requests.find((r) =>
      r.raw.includes('working memory of a long coding session'),
    )
    expect(cond).toBeDefined()
    expect(cond?.headers['x-parent-session-id']).toBe(parent?.id)
    const child = cond?.headers['x-session-id'] as string
    expect(child).toMatch(/^ses_/)
    expect(child).not.toBe(parent?.id)
    // the child is not managed: no envelope in its system prompt (the condenser's own prompt
    // quotes the envelope as data), and no tools at all
    type Body = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] }
    const body = cond?.body as Body
    const system = body.messages.filter((m) => m.role === 'system').map((m) => String(m.content))
    expect(system.join('\n')).not.toMatch(/^<hafiz hash=/m)
    expect(system.join('\n')).toContain('You are a text-processing function inside Hafiz')
    // and none of Kilo's own default prompt (persona, environment block): only Hafiz's text
    expect(system).toHaveLength(1)
    expect(system[0]).toMatch(/^You are a text-processing function inside Hafiz/)
    expect(system[0]).toContain('working memory of a long coding session')
    expect(system[0]).not.toMatch(/<env>|Today's date|Platform:|You are powered by/)
    expect(body.tools ?? []).toEqual([])
    expect(await daemon.service.core.backend.read.getSession(child)).toBeNull()
    const after = await daemon.service.core.backend.read.getSession(parent?.id as string)
    expect(after?.unfiledSummary).toBe('The user asked for invoice totals in integer cents.')
    expect(after?.counters.condense_tokens_in).toBe(900)

    // Kilo's own store: the child's step cost is part of the parent's session family
    const dbDir = join(home, '.local', 'share', 'kilo')
    const db = readdirSync(dbDir).find((f) => /\.db$/.test(f))
    expect(db).toBeDefined()
    const { DatabaseSync } = await import('node:sqlite')
    const sql = new DatabaseSync(join(dbDir, db as string), { readOnly: true })
    const fam = sql
      .prepare('SELECT id, parent_id FROM session WHERE id = ? OR parent_id = ?')
      .all(parent?.id as string, parent?.id as string) as Array<{
      id: string
      parent_id: string | null
    }>
    expect(fam.map((r) => r.id)).toContain(child)
    const cost = sql
      .prepare(
        `SELECT session_id, sum(cast(json_extract(data, '$.cost') AS REAL)) AS cost
         FROM part WHERE json_extract(data, '$.type') = 'step-finish' AND session_id IN (${fam.map(() => '?').join(',')})
         GROUP BY session_id`,
      )
      .all(...fam.map((r) => r.id)) as Array<{ session_id: string; cost: number }>
    sql.close()
    console.log('family step cost by session:', JSON.stringify(cost))
    const childCost = cost.find((r) => r.session_id === child)?.cost ?? 0
    // 900 input tokens at $3/M + 40 output at $15/M
    expect(childCost).toBeCloseTo((900 * 3 + 40 * 15) / 1e6, 8)
    expect(existsSync(join(dbDir, db as string))).toBe(true)
  }, 180000)
})
