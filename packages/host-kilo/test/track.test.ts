// Untracked git repo: one tool, hafiz_track_project, and the switch to managed mode mid-session.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, type ResolvedProject } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createHafizPlugin,
  type Hooks,
  type KiloConfig,
  type KiloMessageWithParts,
  type KiloToolResult,
  setToolVisibility,
  TRACK_TOOL,
  toolNamesForRole,
} from '../src/index.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd })

function repo(files: Record<string, string> = {}) {
  const cwd = tmp('hafiz-repo-')
  git(cwd, 'init', '-q')
  if (Object.keys(files).length) {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(cwd, f, '..'), { recursive: true })
      writeFileSync(join(cwd, f), t)
    }
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'init')
  }
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    HAFIZ_HOME: tmp('hafiz-home-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  return { cwd, env }
}

/** The plugin, with an in-process daemon started on first connect (after tracking). */
async function untracked(r: { cwd: string; env: NodeJS.ProcessEnv }) {
  let daemon: DaemonHandle | undefined
  const hooks = await createHafizPlugin({
    env: r.env,
    hafiz: ['node', '/opt/hafiz/bin.js'],
    noCache: true,
    log: () => undefined,
    connect: async (p: ResolvedProject) => {
      if (!daemon) {
        daemon = await startDaemon({ projectDir: p.worktree, env: r.env, idleShutdownMs: 0 })
        cleanup.unshift(() => daemon?.close()) // after the plugin lets go of it
      }
      return DaemonClient.connect(daemon.socketPath)
    },
  })({ directory: r.cwd, worktree: r.cwd })
  cleanup.push(() => hooks.dispose?.())
  return { hooks, daemon: () => daemon as DaemonHandle }
}

const ev = (type: string, properties: Record<string, unknown>) => ({ event: { type, properties } })
const ctx = (sessionID: string, agent = 'build') => ({ sessionID, messageID: 'm1', agent })
const outputOf = (r: KiloToolResult) => (typeof r === 'string' ? r : r.output)

async function system(hooks: Hooks, sessionID: string) {
  const out = ['You are Kilo.']
  await hooks['experimental.chat.system.transform']?.(
    { sessionID, model: { id: 'm', providerID: 'p' } },
    { system: out },
  )
  return out
}

/** Tool names the request would carry: Kilo drops those the user message sets to false. */
async function visible(hooks: Hooks, sessionID: string) {
  const messages: KiloMessageWithParts[] = [
    { info: { id: 'u1', sessionID, role: 'user' }, parts: [{ type: 'text', text: 'go' }] },
  ]
  await hooks['experimental.chat.messages.transform']?.({}, { messages })
  const off = (messages[0]?.info as { tools?: Record<string, boolean> } | undefined)?.tools ?? {}
  return Object.keys(hooks.tool ?? {})
    .filter((n) => off[n] !== false)
    .sort()
}

const config = loadConfig()
const managerTools = toolNamesForRole(config, 'manager').sort()

describe('untracked git repo', () => {
  it('registers the track tool (and the hidden Hafiz tools) and installs agents up front', async () => {
    const r = repo()
    const { hooks } = await untracked(r)
    expect(Object.keys(hooks.tool ?? {})).toContain(TRACK_TOOL)
    expect(Object.keys(hooks.tool ?? {})).toEqual(expect.arrayContaining(managerTools))
    // per request only the track tool shows
    expect(await visible(hooks, 's1')).toEqual([TRACK_TOOL])

    const cfg: KiloConfig = { compaction: { prune: true } }
    await hooks.config?.(cfg)
    expect(cfg.mcp ?? {}).toEqual({})
    expect(cfg.compaction).toEqual({ prune: true }) // Kilo's own compaction untouched
    expect(Object.keys(cfg.agent ?? {})).toEqual(
      expect.arrayContaining(['manager', 'designer', 'planner', 'worker']),
    )
    // primary agents may track (manager; others through the global default-role map)
    expect(cfg.agent?.manager?.permission).toMatchObject({ [TRACK_TOOL]: 'allow' })
    expect(cfg.permission).toMatchObject({ [TRACK_TOOL]: 'allow' })
    // subagents may not
    for (const a of ['designer', 'planner', 'worker', 'general', 'explore'])
      expect(cfg.agent?.[a]?.permission, a).toMatchObject({ [TRACK_TOOL]: 'deny' })
    // the store root stays denied even before a store exists
    expect(JSON.stringify(cfg.permission)).toContain(`${r.env.HAFIZ_STORE_ROOT}/**`)

    // no envelope, nothing on disk, no daemon
    expect(await system(hooks, 's1')).toEqual(['You are Kilo.'])
    expect(readdirSync(r.env.XDG_RUNTIME_DIR as string)).toEqual([])
    expect(readdirSync(r.env.HAFIZ_STORE_ROOT as string)).toEqual([])
    // a Hafiz tool called before tracking refuses
    await expect(
      hooks.tool?.hafiz_tree_list?.execute({}, ctx('s1')) as Promise<unknown>,
    ).rejects.toThrow(/call hafiz_track_project first/)
  })

  it('hafiz_track_project initialises the repo and switches the session to managed mode', async () => {
    const r = repo()
    const { hooks, daemon } = await untracked(r)
    await hooks.event?.(ev('session.created', { info: { id: 'ses_b', agent: 'build' } }))
    await hooks['chat.message']?.(
      { sessionID: 'ses_b', agent: 'build' },
      { message: {}, parts: [{ type: 'text', text: 'Build the shop' }] },
    )
    const res = await hooks.tool?.[TRACK_TOOL]?.execute(
      { name: 'Shop', reason: 'Multi-step build with subagents.' },
      ctx('ses_b'),
    )
    const line = outputOf(res as KiloToolResult)
    expect(line).toMatch(/^Hafiz now tracks this repo as `Shop` \(prj_\w+\)/)
    expect(line.split('\n')).toHaveLength(1)
    expect(existsSync(join(r.cwd, '.git', 'hafiz', 'project.yaml'))).toBe(true)

    // the daemon knows the calling session: manager role, its worktree
    const read = daemon().service.core.backend.read
    expect(await read.getSession('ses_b')).toMatchObject({
      role: 'manager',
      agent: 'build',
      host: 'kilo',
      worktree: r.cwd,
    })
    const project = await read.getProject()
    expect(project?.onboarding).toBeUndefined() // empty repo: greenfield
    // Hafiz records the reason as progress, never as a decision
    const root = project?.rootBlockId as string
    expect(await read.readLog(root, 'decisions')).toHaveLength(0)
    expect((await read.readLog(root, 'progress')).map((p) => [p.entry.kind, p.entry.text])).toEqual(
      [['changed', 'Tracking with Hafiz: Multi-step build with subagents.']],
    )
    expect((await read.readAudit()).map((a) => a.command)).not.toContain('decision.record')

    // next request: envelope + manager rules, manager tools shown, track tool hidden
    const sys = await system(hooks, 'ses_b')
    expect(sys.join('\n')).toContain('# Hafiz rules — manager')
    expect(sys.join('\n')).toMatch(/<hafiz hash="[0-9a-f]{12}" role="manager">/)
    expect(sys.join('\n')).toContain('Shop')
    const shown = await visible(hooks, 'ses_b')
    expect(shown).not.toContain(TRACK_TOOL)
    expect(shown).toEqual(expect.arrayContaining(managerTools))
    // and they work
    const tree = await hooks.tool?.hafiz_tree_list?.execute({}, ctx('ses_b'))
    expect(outputOf(tree as KiloToolResult)).toContain('Shop')
    // calling it again is harmless
    const again = await hooks.tool?.[TRACK_TOOL]?.execute({ name: 'Other' }, ctx('ses_b'))
    expect(outputOf(again as KiloToolResult)).toBe(
      'Already tracking this repo with Hafiz as `Shop`.',
    )
  })

  it('a subagent cannot start tracking', async () => {
    const r = repo()
    const { hooks } = await untracked(r)
    await hooks.event?.(
      ev('session.created', { info: { id: 'ses_c', parentID: 'ses_p', agent: 'general' } }),
    )
    await expect(
      hooks.tool?.[TRACK_TOOL]?.execute(
        { name: 'Shop' },
        ctx('ses_c', 'general'),
      ) as Promise<unknown>,
    ).rejects.toThrow(/subagent cannot start tracking/)
    expect(existsSync(join(r.cwd, '.git', 'hafiz'))).toBe(false)
  })

  it('brownfield: tracking a repo with code sets onboarding and the manager sees the directive', async () => {
    const files = Object.fromEntries(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'].map((f) => [f, `// ${f}\n`]),
    )
    const r = repo(files)
    const { hooks, daemon } = await untracked(r)
    const res = await hooks.tool?.[TRACK_TOOL]?.execute({ name: 'Legacy' }, ctx('ses_b'))
    expect(outputOf(res as KiloToolResult)).toContain('onboarding is pending')
    const p = await daemon().service.core.backend.read.getProject()
    expect(p?.onboarding).toBe('pending')
    const sys = (await system(hooks, 'ses_b')).join('\n')
    expect(sys).toContain(`spawn the designer once with hafiz:block=${p?.rootBlockId}`)
  })
})

describe('setToolVisibility', () => {
  it('hides and un-hides only the named tools on user messages', () => {
    const messages: KiloMessageWithParts[] = [
      { info: { id: 'u', sessionID: 's', role: 'user', tools: { bash: false } }, parts: [] },
      { info: { id: 'a', sessionID: 's', role: 'assistant' }, parts: [] },
    ]
    setToolVisibility(messages, ['hafiz_a'], ['hafiz_b'])
    expect(messages[0]?.info.tools).toEqual({ bash: false, hafiz_a: false })
    expect(messages[1]?.info.tools).toBeUndefined()
    setToolVisibility(messages, ['hafiz_b'], ['hafiz_a'])
    expect(messages[0]?.info.tools).toEqual({ bash: false, hafiz_b: false })
  })
})
