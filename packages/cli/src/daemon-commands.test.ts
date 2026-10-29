import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient, type DaemonHandle, readLock, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { type Io, run } from './commands.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function setup() {
  const cwd = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd })
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const out: string[] = []
  const err: string[] = []
  const io: Io = { cwd, env, out: (l) => out.push(l), err: (l) => err.push(l) }
  expect(await run(['init', 'Shop'], io)).toBe(0)
  const d: DaemonHandle = await startDaemon({ projectDir: cwd, env, idleShutdownMs: 0 })
  cleanup.push(() => d.close())
  io.connect = () => DaemonClient.connect(d.socketPath)
  return { io, out, err, d, cwd, env }
}

describe('cli: daemon-backed commands', () => {
  it('direct records a standing decision through the daemon', async () => {
    const { io, out, err, d } = await setup()
    expect(await run(['direct', 'Never touch the billing schema.', '--kind', 'never'], io)).toBe(0)
    expect(out.join('\n')).toMatch(/recorded standing decision dec_\w+ \(never\)/)
    const root = (await d.service.core.backend.read.getProject())?.rootBlockId as string
    const decisions = await d.service.core.backend.read.readLog(root, 'decisions')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.entry).toMatchObject({ standing: 'never', by: { role: 'user' } })
    expect(await run(['direct', 'x', '--kind', 'sometimes'], io)).toBe(1)
    expect(err.join('\n')).toContain('--kind must be')
    expect(await run(['direct'], io)).toBe(1)
  })

  it('status, focus, explain and review reflect live sessions and proposals', async () => {
    const { io, out, d } = await setup()
    const core = d.service.core
    const root = (await core.backend.read.getProject())?.rootBlockId as string

    const mgr = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => mgr.close())
    await mgr.openSession({ id: 'mgr', host: 't', role: 'manager', agent: 'boss' })
    const { result } = await mgr.dispatch<{ id: string }>('block.create', {
      parent: root,
      title: 'Auth',
    })
    await mgr.dispatch('block.set_status', { id: result.id, status: 'active' })
    const w = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => w.close())
    await w.openSession({ id: 'w1', host: 't', role: 'worker', spawnedBlock: result.id })
    await w.countersAdd({ tool_calls_hafiz: 3 })
    await w.dispatch('block.request_done', {
      id: result.id,
      digest: { outcome: 'ok', interface_delta: ['none'], pointers: [{ label: 'pr', ref: '#1' }] },
    })

    out.length = 0
    expect(await run(['status'], io)).toBe(0)
    const status = out.join('\n')
    expect(status).toMatch(/^project prj_\w+ \(Shop\) epoch \d+/)
    expect(status).toContain('manager')
    expect(status).toContain('mgr (boss)')
    expect(status).toContain('w1')
    expect(status).toContain('tool_calls_hafiz=3')
    expect(status).toContain('proposals: 1 pending')
    expect(status).not.toMatch(/token/)
    out.length = 0
    await run(['status', '--json'], io)
    const js = JSON.parse(out.join('\n'))
    expect(js.pendingProposals).toBe(1)
    expect(js.sessions[0].token).toBeUndefined()

    out.length = 0
    expect(await run(['focus'], io)).toBe(0)
    expect(out.join('\n')).toContain('w1')
    expect(out.join('\n')).toContain(result.id)
    out.length = 0
    expect(await run(['focus', '--role', 'worker'], io)).toBe(0)
    expect(out[0]).toMatch(/^worker \(spawned_block\)/)

    out.length = 0
    expect(await run(['explain', result.id, '--role', 'worker'], io)).toBe(0)
    expect(out.join('\n').length).toBeGreaterThan(0)
    out.length = 0
    expect(await run(['explain', result.id, '--session', 'mgr'], io)).toBe(0)

    out.length = 0
    expect(await run(['review'], io)).toBe(0)
    const pid = /^(prop_\w+)/.exec(out[0] ?? '')?.[1] as string
    expect(pid).toBeTruthy()
    expect(await run(['review', '--reject', pid], io)).toBe(0)
    out.length = 0
    await run(['review'], io)
    expect(out).toEqual(['no pending proposals'])
    expect(await run(['review', '--accept', 'a', '--reject', 'b'], io)).toBe(1)
  })

  it('review: a design review lists kind, version, row and note; --show prints it; --reject takes a note', async () => {
    const { io, out, err, d } = await setup()
    const core = d.service.core
    const root = (await core.backend.read.getProject())?.rootBlockId as string
    const user = { sessionId: 'cli', role: 'user' }
    const block = (await core.blockCreate(user, { parent: root, title: 'Billing' })).result.id
    await core.sessionOpen({ id: 'ds', host: 't', role: 'designer', spawnedBlock: block })
    const sections = { purpose: 'money in', scope: ['in: invoices'], interface: {} }
    await core.docWrite({ sessionId: 'ds', role: 'designer' }, { block, type: 'design', sections })
    // filed as it is written
    const [p] = (await core.reviewList(user)).filter((x) => x.source === 'review')
    const id = p?.id as string

    out.length = 0
    expect(await run(['review'], io)).toBe(0)
    expect(out[0]).toBe(`${id}  design v1  from review  on ${block} 'Billing'  queue`)
    expect(out[1]).toBe("    design v1 of 'Billing': new: purpose, scope, interface")
    expect(out[2]).toContain(`hafiz review --accept ${id}`)
    out.length = 0
    expect(await run(['review', '--show', id], io)).toBe(0)
    expect(out.join('\n')).toContain('Purpose: money in')
    expect(await run(['review', '--note', 'x'], io)).toBe(1)
    expect(err.join('\n')).toContain('--note goes with --reject')
    expect(await run(['review', '--reject', id, '--note', 'name the refunds owner'], io)).toBe(0)
    const [rejected] = await core.reviewList(user, 'rejected')
    expect(rejected).toMatchObject({ id, resolutionNote: 'name the refunds owner' })
  })

  it('status shows a cost table; review lists source, note and the command; checkpoint flags sessions', async () => {
    const { io, out, d } = await setup()
    const core = d.service.core
    const root = (await core.backend.read.getProject())?.rootBlockId as string
    const mgr = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => mgr.close())
    await mgr.openSession({ id: 'mgr', host: 't', role: 'manager' })
    await mgr.contextFor() // one view re-emit
    await mgr.countersAdd({
      wire_requests: 2,
      wire_input: 100,
      wire_cache_read: 300,
      condensations: 1,
    })
    await core.proposalAdd(
      {
        kind: 'decision',
        source: 'condenser',
        blockId: root,
        payload: {
          command: 'decision.record',
          args: { block: root, title: 'Cents', decision: 'Integer cents.' },
        },
        note: 'condenser: the user seems to have decided "Cents"',
      },
      { sessionId: 'mgr', role: 'manager' },
    )

    expect(await run(['status'], io)).toBe(0)
    const status = out.join('\n')
    expect(status).toMatch(
      /cost:\n\s+session\s+role\s+re-emits\s+tok\/view\s+delta tok\s+cache hit\s+condense/,
    )
    expect(status).toMatch(/mgr\s+manager\s+1\s+\d+\s+0\s+75%\s+1\s+0/)

    out.length = 0
    expect(await run(['review'], io)).toBe(0)
    expect(out[0]).toMatch(/^prop_\w+ {2}decision {2}from condenser {2}on \S+/)
    expect(out[1]).toContain('condenser: the user seems to have decided "Cents"')
    expect(out[2]).toContain('accept runs: decision.record {"block":')

    out.length = 0
    expect(await run(['checkpoint'], io)).toBe(0)
    expect(out.join('\n')).toContain('checkpoint requested for mgr')
    expect((await core.backend.read.getSession('mgr'))?.checkpointRequested).toBe(true)
    expect((await core.backend.read.getSession('cli'))?.checkpointRequested).toBeUndefined()
  })

  it('smoke: a write command spawns a detached daemon that serves it, then idles out', async () => {
    const bin = join(import.meta.dirname, '../dist/bin.js')
    if (!existsSync(bin)) return // run `pnpm build` first
    const cwd = tmp('hafiz-repo-')
    execFileSync('git', ['init', '-q'], { cwd })
    const env = {
      ...process.env,
      HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
      XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
    }
    const go = (...args: string[]) =>
      spawnSync('node', [bin, ...args], { cwd, env, encoding: 'utf8' })
    expect(go('init', 'Smoke').status).toBe(0)
    const r = go('direct', 'Always run the linter.')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/recorded standing decision/)
    const store = join(
      env.HAFIZ_STORE_ROOT,
      execFileSync('ls', [env.HAFIZ_STORE_ROOT], { encoding: 'utf8' }).trim(),
    )
    const lock = readLock(store)
    expect(lock?.pid).toBeGreaterThan(0)
    process.kill(lock?.pid as number, 'SIGTERM')
    for (let i = 0; i < 50 && readLock(store); i++) await new Promise((r) => setTimeout(r, 100))
    expect(readLock(store)).toBeNull()
  })
})
