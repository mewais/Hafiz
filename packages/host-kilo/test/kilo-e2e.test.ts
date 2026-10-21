// Real Kilo, no model: `kilo run` in a Hafiz repo with a custom OpenAI-compatible provider pointing
// at the mock LLM and this plugin loaded from dist. Slow (~10 s per run) and needs the Kilo CLI,
// so it runs only with HAFIZ_KILO_E2E=1 and HAFIZ_KILO_BIN=<path to the kilo binary>
// (`npm i @kilocode/cli` puts it at node_modules/@kilocode/cli-linux-x64/bin/kilo).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Io, run } from '@hafiz/cli'
import { loadConfig, resolveProject } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, readLock, startDaemon } from '@hafiz/gateway-mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TRACK_TOOL, toolNamesForRole } from '../src/index.js'
import { type MockLlm, type RecordedRequest, type ScriptedReply, startMockLlm } from './mock-llm.js'

const BIN = process.env.HAFIZ_KILO_BIN
const enabled = process.env.HAFIZ_KILO_E2E === '1' && !!BIN
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const PLUGIN = pathToFileURL(resolve(import.meta.dirname, '..', 'dist', 'index.js')).href

describe.skipIf(!enabled)('real Kilo CLI (HAFIZ_KILO_E2E=1)', () => {
  let mock: MockLlm
  let repo: string
  let env: NodeJS.ProcessEnv
  let close: () => Promise<void>
  let block: string
  let daemon: DaemonHandle
  let responder: (req: RecordedRequest) => ScriptedReply = () => ({ text: 'All good.' })

  beforeAll(async () => {
    repo = tmp('hafiz-kilo-repo-')
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const home = tmp('hafiz-kilo-home-')
    mkdirSync(join(home, '.config'), { recursive: true })
    env = {
      ...process.env,
      HOME: home,
      HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
      XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_SHARE: '1',
      KILO_DISABLE_SESSION_INGEST: '1',
    }
    const io: Io = { cwd: repo, env, out: () => undefined, err: () => undefined }
    expect(await run(['init', 'Shop'], io)).toBe(0)
    const d = await startDaemon({ projectDir: repo, env, idleShutdownMs: 0 })
    daemon = d
    const u = await DaemonClient.connect(d.socketPath)
    await u.openSession({ id: 'cli', host: 'test', role: 'user' })
    const root = (await u.treeList())[0]?.id as string
    const { result } = await u.dispatch<{ id: string }>('block.create', {
      parent: root,
      title: 'Payments',
    })
    await u.dispatch('block.set_status', { id: result.id, status: 'active' })
    // designed and planned, so a worker may be spawned on it (policies.yaml spawn.roles_by_state)
    await u.dispatch('doc.write', {
      block: result.id,
      type: 'design',
      sections: {
        purpose: 'Take card payments.',
        scope: ['charges', 'webhooks'],
        interface: { provides: [{ name: 'charge' }], consumes: [], contracts: [] },
      },
    })
    await u.dispatch('doc.write', {
      block: result.id,
      type: 'plan',
      sections: { steps: [{ id: 's1', title: 'Webhooks' }], acceptance: ['webhooks verified'] },
    })
    u.close()
    block = result.id
    mock = await startMockLlm({ fallback: (req) => responder(req) })
    close = async () => {
      await mock.close()
      await d.close()
    }
  }, 60000)
  afterAll(async () => close?.())

  function kilo(
    shaper: string,
    prompt: string,
    agent = 'manager',
    cwd = repo,
  ): Promise<{ code: number; output: string }> {
    const config = {
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
            },
          },
        },
      },
      model: 'mock/mock-model',
      small_model: 'mock/mock-model',
      plugin: [[PLUGIN, { shaper }]],
      autoupdate: false,
      share: 'disabled',
    }
    return new Promise((res, rej) => {
      const args = ['run', '--print-logs', '--log-level', 'WARN', '--agent', agent, prompt]
      const p = spawn(BIN as string, args, {
        cwd,
        // Kilo takes its directory from $PWD, not the process cwd
        env: { ...env, PWD: cwd, KILO_CONFIG_CONTENT: JSON.stringify(config) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const keep = (c: Buffer) => {
        output = (output + c.toString()).slice(-4000)
      }
      p.stdout?.on('data', keep)
      p.stderr?.on('data', keep)
      const t = setTimeout(() => p.kill('SIGKILL'), 110000)
      p.on('close', (code) => {
        clearTimeout(t)
        res({ code: code ?? -1, output })
      })
      p.on('error', rej)
    })
  }

  const withEnvelope = (marker: string) =>
    mock.requests.filter((r) => r.raw.includes(marker) && r.raw.includes('<hafiz hash='))

  for (const shaper of ['proxy', 'hooks'])
    it(`injects the <hafiz> envelope through the ${shaper} shaper`, async () => {
      const marker = `ping via ${shaper}`
      const r = await kilo(shaper, marker)
      if (r.code !== 0) console.error(r.output)
      expect(r.code).toBe(0)
      const hits = withEnvelope(marker)
      expect(hits.length).toBeGreaterThan(0)
      const body = hits[0]?.body as { messages: Array<{ role: string; content: unknown }> }
      const sys = body.messages.filter((m) => m.role === 'system').map((m) => String(m.content))
      expect(sys.join('\n')).toMatch(/<hafiz hash="[0-9a-f]{12}" role="manager">/)
      expect(sys.join('\n')).toContain('Payments')
      expect(hits[0]?.headers['x-hafiz-session']).toBeUndefined()
    }, 120000)

  // ── native tools: scripted tool calls through real Kilo reach the daemon ──

  type Msg = { role: string; content?: unknown; tool_calls?: unknown[] }
  type Fn = {
    name?: string
    parameters?: { properties?: Record<string, { description?: string }>; required?: string[] }
  }
  type Body = { messages?: Msg[]; tools?: Array<{ function?: Fn }> }
  const toolsOf = (r: RecordedRequest) =>
    ((r.body as Body).tools ?? []).map((t) => t.function?.name ?? '').filter(Boolean)
  const hafizTools = (r: RecordedRequest) => toolsOf(r).filter((n) => n.startsWith('hafiz_'))
  const systemOf = (r: RecordedRequest) =>
    ((r.body as Body).messages ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => String(m.content))
      .join('\n')
  const toolResults = (r: RecordedRequest) =>
    ((r.body as Body).messages ?? []).filter((m) => m.role === 'tool').length
  const roleOf = (r: RecordedRequest) =>
    /<hafiz hash="[0-9a-f]+" role="(\w+)">/.exec(systemOf(r))?.[1]

  it('the manager calls a hafiz_* tool and the daemon records it as that Kilo session', async () => {
    const marker = 'native manager call'
    responder = (req) => {
      if (!req.raw.includes(marker) || !toolsOf(req).length) return { text: 'Title' }
      if (toolResults(req) === 0)
        return {
          toolCalls: [
            {
              name: 'hafiz_decision_record',
              arguments: { block, title: 'PSP', decision: 'Use Stripe.', standing: 'always' },
            },
          ],
        }
      return { text: 'Recorded.' }
    }
    const r = await kilo('hooks', marker)
    if (r.code !== 0) console.error(r.output)
    expect(r.code).toBe(0)
    const first = mock.requests.find((q) => q.raw.includes(marker) && toolsOf(q).length)
    expect(first).toBeDefined()
    const config = loadConfig()
    expect(hafizTools(first as RecordedRequest).sort()).toEqual(
      toolNamesForRole(config, 'manager').sort(),
    )
    // the role agent's prompt is the rules (installed once, after the separator), no copy from the shaper
    const sys = systemOf(first as RecordedRequest)
    expect(sys.split('# Hafiz rules — manager')).toHaveLength(2)
    expect(sys).toContain('<!-- Hafiz manager rules, appended by the Hafiz plugin')
    const read = daemon.service.core.backend.read
    const audit = (await read.readAudit()).filter((a) => a.command === 'decision.record')
    expect(audit).toHaveLength(1)
    expect(audit[0]?.by).toMatchObject({ role: 'manager', agent: 'manager' })
    const sid = audit[0]?.by.sessionId as string
    expect(sid).toMatch(/^ses_/) // the Kilo session id, not a shared MCP process id
    expect((await read.getSession(sid))?.host).toBe('kilo')
    // the tool result went back to the model
    const after = mock.requests.find((q) => q.raw.includes(marker) && toolResults(q) > 0)
    expect(after?.raw).toContain('decision_record')
  }, 120000)

  it('build is managed as the manager; a worker it spawns on a block gets its own session and tools', async () => {
    const marker = 'native worker spawn'
    responder = (req) => {
      if (!req.raw.includes(marker) || !toolsOf(req).length) return { text: 'Title' }
      const role = roleOf(req)
      if (role === 'worker') {
        if (toolResults(req) === 0)
          return {
            toolCalls: [
              {
                name: 'hafiz_progress_append',
                arguments: { block, kind: 'found', text: 'Webhooks arrive out of order.' },
              },
            ],
          }
        return { text: 'Done.\n```hafiz-report\noutcome: partial\n```' }
      }
      if (toolResults(req) === 0)
        return {
          toolCalls: [
            {
              name: 'task',
              arguments: {
                description: 'Payments work',
                prompt: `${marker}: investigate webhooks`,
                subagent_type: 'worker',
                block,
              },
            },
          ],
        }
      return { text: 'All good.' }
    }
    const r = await kilo('hooks', marker, 'build')
    if (r.code !== 0) console.error(r.output)
    expect(r.code).toBe(0)
    const config = loadConfig()
    const reqs = mock.requests.filter((q) => q.raw.includes(marker) && toolsOf(q).length)
    const build = reqs.find((q) => roleOf(q) === 'manager')
    const worker = reqs.find((q) => roleOf(q) === 'worker')
    expect(build && hafizTools(build).sort()).toEqual(toolNamesForRole(config, 'manager').sort())
    // build keeps Kilo's own prompt; the shaper adds the manager rules once
    expect(systemOf(build as RecordedRequest).split('# Hafiz rules — manager')).toHaveLength(2)
    expect(worker && hafizTools(worker).sort()).toEqual(toolNamesForRole(config, 'worker').sort())
    const read = daemon.service.core.backend.read
    const log = await read.readLog(block, 'progress')
    const found = log
      .map(
        (e) => e.entry as { kind: string; text: string; by: { sessionId: string; role: string } },
      )
      .find((e) => e.kind === 'found')
    expect(found?.by.role).toBe('worker')
    const ws = await read.getSession(found?.by.sessionId as string)
    expect(ws).toMatchObject({ role: 'worker', host: 'kilo', agent: 'worker' })
    expect(ws?.focus.blocks).toEqual([block])
    const parent = await read.getSession(ws?.parentSessionId as string)
    expect(parent).toMatchObject({ role: 'manager', agent: 'build' })
  }, 120000)

  it('task takes a checked block: bad spawns are refused, the manager reads only the report', async () => {
    const marker = 'checked spawn'
    const prose = 'I read every webhook handler and traced each retry path in detail.'
    const spawn = (b: string) => ({
      toolCalls: [
        {
          name: 'task',
          arguments: {
            description: 'Payments work',
            prompt: `${marker}: look at webhooks`,
            subagent_type: 'worker',
            block: b,
          },
        },
      ],
    })
    responder = (req) => {
      if (!req.raw.includes(marker) || !toolsOf(req).length) return { text: 'Title' }
      if (roleOf(req) === 'worker') {
        if (toolResults(req) === 0)
          return {
            toolCalls: [
              {
                name: 'hafiz_progress_append',
                arguments: { block, kind: 'found', text: 'Retries are not idempotent.' },
              },
            ],
          }
        return { text: `${prose}\n\n\`\`\`hafiz-report\noutcome: partial — traced\n\`\`\`` }
      }
      const n = toolResults(req)
      if (n === 0) return spawn('none') // a role agent never works off-block
      if (n === 1) return spawn('blk_nope') // unknown id
      if (n === 2) return spawn('payments') // by title
      return { text: 'All good.' }
    }
    const r = await kilo('hooks', marker)
    if (r.code !== 0) console.error(r.output)
    expect(r.code).toBe(0)
    const reqs = mock.requests.filter((q) => q.raw.includes(marker) && toolsOf(q).length)
    const manager = reqs.filter((q) => roleOf(q) === 'manager')
    // the modified schema reaches the model: task has a required `block`
    const fn = ((manager[0]?.body as Body | undefined)?.tools ?? []).find(
      (t) => t.function?.name === 'task',
    )
    expect(fn?.function?.parameters?.required).toContain('block')
    expect(fn?.function?.parameters?.properties?.block?.description).toMatch(/or "none"/)
    // the two bad calls came back as tool errors; the third spawned the worker
    const toolText = (q: RecordedRequest | undefined) =>
      ((q?.body as Body | undefined)?.messages ?? [])
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    const last = manager.find((q) => toolResults(q) === 3)
    const results = toolText(last)
    expect(results[0]).toMatch(/worker is a Hafiz role agent and always works on a block/)
    expect(results[1]).toMatch(/no block 'blk_nope'\. Valid block ids:[\s\S]*Payments/)
    // only the report reaches the manager, plus the mechanical note (no done, no blocked)
    expect(results[2]).toContain('```hafiz-report\noutcome: partial — traced\n```')
    expect(results[2]).toContain('ended without a done request or a blocked entry')
    expect(results[2]).not.toContain(prose)
    // the worker ran on the block; its full text is in the store
    const worker = reqs.find((q) => roleOf(q) === 'worker')
    expect(worker?.raw).toContain(`hafiz:block=${block}`)
    const log = await daemon.service.core.backend.read.readLog(block, 'progress')
    const texts = log.map((e) => (e.entry as { kind: string; text: string }).text)
    expect(texts.some((t) => t.startsWith(prose))).toBe(true)
  }, 120000)

  // ── untracked repo: hafiz_track_project switches the running session to managed mode ──

  it('in an untracked repo the agent tracks it, and its next request is managed', async () => {
    const fresh = tmp('hafiz-kilo-untracked-')
    execFileSync('git', ['init', '-q'], { cwd: fresh })
    const marker = 'track this multi-step build'
    responder = (req) => {
      if (!req.raw.includes(marker) || !toolsOf(req).length) return { text: 'Title' }
      if (toolResults(req) === 0)
        return {
          toolCalls: [
            {
              name: TRACK_TOOL,
              arguments: { name: 'Fresh', reason: 'Multi-step build.' },
            },
          ],
        }
      return { text: 'Tracking this repo with Hafiz as `Fresh`.' }
    }
    const r = await kilo('auto', marker, 'build', fresh)
    try {
      if (r.code !== 0) console.error(r.output)
      expect(r.code).toBe(0)
      const reqs = mock.requests.filter((q) => q.raw.includes(marker) && toolsOf(q).length)
      const first = reqs.find((q) => toolResults(q) === 0)
      const next = reqs.find((q) => toolResults(q) > 0)
      // before: only the track tool, no envelope
      expect(first && hafizTools(first)).toEqual([TRACK_TOOL])
      expect(systemOf(first as RecordedRequest)).not.toContain('<hafiz hash=')
      // the very next request of the same turn: envelope, rules and the manager's tools
      const config = loadConfig()
      expect(next && hafizTools(next).sort()).toEqual(toolNamesForRole(config, 'manager').sort())
      expect(systemOf(next as RecordedRequest)).toMatch(
        /<hafiz hash="[0-9a-f]{12}" role="manager">/,
      )
      expect(systemOf(next as RecordedRequest)).toContain('# Hafiz rules — manager')
      expect(next?.raw).toContain('Hafiz now tracks this repo as')
      expect(existsSync(join(fresh, '.git', 'hafiz', 'project.yaml'))).toBe(true)
    } finally {
      // the plugin started a real daemon for the new project; stop it
      try {
        const lock = readLock(resolveProject(fresh, env).storeDir)
        if (lock) process.kill(lock.pid)
      } catch {}
    }
  }, 120000)
})
