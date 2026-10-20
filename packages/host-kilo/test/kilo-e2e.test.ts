// Real Kilo, no model: `kilo run` in a Hafiz repo with a custom OpenAI-compatible provider pointing
// at the mock LLM and this plugin loaded from dist. Slow (~10 s per run) and needs the Kilo CLI,
// so it runs only with HAFIZ_KILO_E2E=1 and HAFIZ_KILO_BIN=<path to the kilo binary>
// (`npm i @kilocode/cli` puts it at node_modules/@kilocode/cli-linux-x64/bin/kilo).
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Io, run } from '@hafiz/cli'
import { loadConfig } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toolNamesForRole } from '../src/index.js'
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
        cwd: repo,
        // Kilo takes its directory from $PWD, not the process cwd
        env: { ...env, PWD: repo, KILO_CONFIG_CONTENT: JSON.stringify(config) },
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
  type Body = { messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> }
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
                prompt: `hafiz:block=${block} ${marker}: investigate webhooks`,
                subagent_type: 'worker',
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
    expect(systemOf(build as RecordedRequest)).toContain('# Hafiz rules — manager')
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
})
