import { spawnSync } from 'node:child_process'
import { statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, makeProject, startFor } from '../../test/helpers.js'
import {
  type DaemonClient,
  type DaemonHandle,
  DaemonLockedError,
  lockPath,
  RPC_CODES,
  RpcError,
  readLock,
} from '../index.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

async function boot(extra = {}) {
  const p = await makeProject()
  const d = await startFor(p, extra)
  cleanup.push(() => d.close())
  return { p, d }
}

async function client(d: DaemonHandle): Promise<DaemonClient> {
  const c = await connect(d)
  cleanup.push(() => c.close())
  return c
}

async function user(d: DaemonHandle) {
  const c = await client(d)
  await c.openSession({ id: 'cli', host: 'cli', role: 'user' })
  return c
}

async function seed(u: DaemonClient) {
  const root = (await u.treeList())[0]?.id as string
  const { result } = await u.dispatch<{ id: string }>('block.create', {
    parent: root,
    title: 'Billing',
  })
  await u.dispatch('block.set_status', { id: result.id, status: 'active' })
  return { root, block: result.id }
}

describe('daemon', () => {
  it('creates the runtime dir 0700 and the socket 0600', async () => {
    const { d } = await boot()
    expect(statSync(dirname(d.socketPath)).mode & 0o777).toBe(0o700)
    expect(statSync(d.socketPath).mode & 0o777).toBe(0o600)
  })

  it('serialises parallel writers from two worker sessions over the socket', async () => {
    const { d } = await boot()
    const u = await user(d)
    const { block } = await seed(u)
    const [a, b] = await Promise.all(
      ['w1', 'w2'].map(async (id) => {
        const c = await client(d)
        await c.openSession({ id, host: 'test', role: 'worker', spawnedBlock: block })
        return c
      }),
    )
    const append = (c: DaemonClient, who: string, i: number) =>
      c.dispatch('progress.append', { block, kind: 'found', text: `${who} finding ${i}` })
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => [
        append(a as DaemonClient, 'w1', i),
        append(b as DaemonClient, 'w2', i),
      ]).flat(),
    )
    const log = await d.service.core.backend.read.readLog(block, 'progress')
    expect(log).toHaveLength(30)
    expect(new Set(log.map((r) => r.entry.by.sessionId))).toEqual(new Set(['w1', 'w2']))
    expect(new Set(log.map((r) => r.seq)).size).toBe(30)
  })

  it('refuses a second daemon on the same store and reclaims a stale lock', async () => {
    const { p, d } = await boot()
    await expect(startFor(p)).rejects.toBeInstanceOf(DaemonLockedError)
    await d.close()
    expect(readLock(p.storeDir)).toBeNull()

    const dead = spawnSync(process.execPath, ['-e', '0']).pid as number
    writeFileSync(lockPath(p.storeDir), JSON.stringify({ pid: dead, socket: '', startedAt: '' }))
    const d2 = await startFor(p)
    cleanup.push(() => d2.close())
    expect(readLock(p.storeDir)?.pid).toBe(process.pid)
  })

  it('shuts down after the idle period with no connections', async () => {
    const { d } = await boot({ idleShutdownMs: 250 })
    const c = await connect(d)
    await new Promise((r) => setTimeout(r, 450))
    // still up while a client is connected
    await c.call('session.open', { id: 'x', host: 't', role: 'worker' })
    c.close()
    await Promise.race([
      d.closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error('did not shut down')), 3000)),
    ])
    expect(() => statSync(d.socketPath)).toThrow()
  })

  it('maps errors to stable JSON-RPC codes carrying the error JSON', async () => {
    const { d } = await boot()
    const u = await user(d)
    const { block } = await seed(u)
    const design = { purpose: 'p', scope: ['in: a'], interface: { provides: [{ name: 'f()' }] } }
    await u.dispatch('doc.write', { block, type: 'design', sections: design })

    const conflict = await u
      .dispatch('doc.write', { block, type: 'design', sections: design, expectedVersion: 0 })
      .catch((e) => e)
    expect(conflict).toBeInstanceOf(RpcError)
    expect(conflict.code).toBe(RPC_CODES.conflict)
    expect(conflict.hafizCode).toBe('conflict')
    expect(conflict.data.current.version).toBe(1)

    const w = await client(d)
    await w.openSession({ id: 'w', host: 't', role: 'worker', spawnedBlock: block })
    const forbidden = await w
      .dispatch('block.set_status', { id: block, status: 'done' })
      .catch((e) => e)
    expect(forbidden.code).toBe(RPC_CODES.forbidden)
    expect(forbidden.message).toContain("role 'worker' may not call")

    const missing = await u
      .dispatch('progress.append', { block: 'nope', kind: 'done', text: 'x' })
      .catch((e) => e)
    expect(missing.code).toBe(RPC_CODES.not_found)

    const bad = await (await client(d)).call('tree.list', { token: 'bogus' }).catch((e) => e)
    expect(bad.code).toBe(RPC_CODES.unauthorized)
    const unknown = await u.call('nope').catch((e) => e)
    expect(unknown.code).toBe(RPC_CODES.method_not_found)
    const invalid = await u.call('block.read', {}).catch((e) => e)
    expect(invalid.code).toBe(RPC_CODES.invalid_params)
  })

  it('refreshes computed focus for all_active sessions when a block goes active', async () => {
    const { d } = await boot()
    const u = await user(d)
    const m = await client(d)
    await m.openSession({ id: 'mgr', host: 't', role: 'manager' })
    expect((await m.sessionStatus()).session.focus.blocks).toEqual([])
    const root = (await u.treeList())[0]?.id as string
    const { result } = await u.dispatch<{ id: string }>('block.create', {
      parent: root,
      title: 'Auth',
    })
    expect((await m.sessionStatus()).session.focus.blocks).toEqual([])
    await u.dispatch('block.set_status', { id: result.id, status: 'active' })
    expect((await m.sessionStatus()).session.focus.blocks).toEqual([result.id])
  })

  it('queues nudges once and announces new proposals to reviewers', async () => {
    const { d } = await boot()
    const u = await user(d)
    const m = await client(d)
    await m.openSession({ id: 'mgr', host: 't', role: 'manager' })
    const w = await client(d)
    await w.openSession({ id: 'w', host: 't', role: 'worker' })

    // tree-less project: counters past the nudge threshold queue one line, once
    await w.countersAdd({ tool_calls: 30 })
    await w.countersAdd({ tool_calls: 30 })
    const nudges = await w.noticesDrain()
    expect(nudges.map((n) => n.event)).toEqual(['nudge'])
    expect(nudges[0]?.text).toContain('30 tool calls')
    expect(await w.noticesDrain()).toEqual([])

    // a worker's done request queues a proposal notice for the manager
    const { block } = await seed(u)
    const w2 = await client(d)
    await w2.openSession({ id: 'w2', host: 't', role: 'worker', spawnedBlock: block })
    await w2.dispatch('block.request_done', {
      id: block,
      digest: {
        outcome: 'done',
        interface_delta: ['none'],
        pointers: [{ label: 'pr', ref: '#1' }],
      },
    })
    const q = await m.noticesDrain()
    expect(q.map((n) => n.event)).toEqual(['proposal'])
    expect((await m.proposalList('pending')).length).toBe(1)
    expect(await w2.noticesDrain()).toEqual([])
  })

  it('re-attaches a session by id and rejects a role change', async () => {
    const { d } = await boot()
    const u = await user(d)
    const { block } = await seed(u)
    const a = await client(d)
    const s1 = await a.openSession({ id: 'w', host: 't', role: 'worker', spawnedBlock: block })
    const b = await client(d)
    const s2 = await b.openSession({ id: 'w', host: 't', role: 'worker' })
    expect(s2.token).toBe(s1.token)
    expect(s2.focus.blocks).toEqual([block])
    await expect(b.openSession({ id: 'w', host: 't', role: 'manager' })).rejects.toMatchObject({
      code: RPC_CODES.validation,
    })
    await a.sessionEnd()
    await expect(
      a.dispatch('progress.append', { block, kind: 'done', text: 'x' }),
    ).rejects.toMatchObject({
      code: RPC_CODES.unauthorized,
    })
  })
})
