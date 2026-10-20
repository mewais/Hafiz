import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Core, loadConfig } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
import { describe, expect, it } from 'vitest'
import { type Io, init, run, userActor } from './commands.js'
import { findPointerFile, originFingerprint, resolveProject } from './resolve.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))

function repo() {
  const dir = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

function harness(cwd: string, storeRoot: string) {
  const out: string[] = []
  const err: string[] = []
  const io: Io = {
    cwd,
    env: { ...process.env, HAFIZ_STORE_ROOT: storeRoot },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  }
  return { io, out, err }
}

const design = (purpose: string) => ({
  purpose,
  scope: ['in: x', 'out: y'],
  interface: { provides: [{ name: 'f()', type: 'fn' }], consumes: [] },
})

describe('cli', () => {
  it('runs init, tree, show, history and revert', async () => {
    const cwd = repo()
    const storeRoot = tmp('hafiz-stores-')
    const { io, out, err } = harness(cwd, storeRoot)

    expect(await run(['init', 'Shop'], io)).toBe(0)
    const pointerFile = join(cwd, '.git/hafiz/project.yaml')
    expect(findPointerFile(join(cwd, 'sub/dir'))).toBe(pointerFile)
    const { pointer, storeDir } = resolveProject(cwd, io.env)
    expect(pointer.fingerprint).toBe(originFingerprint(cwd))
    expect(pointer.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(storeDir).toBe(join(storeRoot, pointer.id))
    expect(existsSync(join(storeDir, '.git'))).toBe(true)

    // second init refuses
    out.length = err.length = 0
    expect(await run(['init', 'Shop'], io)).toBe(1)
    expect(err.join('\n')).toContain('already initialised')

    // add a child block and edit its design twice, as the CLI user
    const backend = new FsBackend({ dir: storeDir, minorBatchSeconds: 0 })
    await backend.open()
    const core = new Core({ config: loadConfig(), backend })
    const root = (await backend.read.getProject())?.rootBlockId as string
    const me = userActor()
    const child = (await core.blockCreate(me, { parent: root, title: 'Billing' })).result
    await core.docWrite(me, { block: child.id, type: 'design', sections: design('first') })
    await core.docWrite(me, { block: child.id, type: 'design', sections: design('second') })
    await backend.close()

    out.length = err.length = 0
    expect(await run(['tree'], io)).toBe(0)
    expect(out[0]).toMatch(/^\[active\] shop-[0-9a-f]+ — Shop \(root\)$/)
    expect(out[1]).toMatch(/^ {2}\[\w+\] billing-[0-9a-f]+ — Billing \(/)
    out.length = 0
    await run(['tree', '--json'], io)
    expect(JSON.parse(out.join('\n'))).toHaveLength(2)

    out.length = err.length = 0
    expect(await run(['show', child.id, '--zoom', 'FULL'], io)).toBe(0)
    expect(out.join('\n').split('\n')[0]).toBe(`# Billing [${child.id}] planned`)
    expect(out.join('\n')).toContain('Purpose: second')
    expect(err).toEqual([])
    out.length = 0
    expect(await run(['show', child.id, '--zoom', 'LINE'], io)).toBe(0)
    expect(out).toEqual([`# Billing [${child.id}] planned`])
    expect(await run(['show', child.id, '--zoom', 'HUGE'], io)).toBe(1)
    expect(err.join('\n')).toContain('unknown zoom')

    // an ad-hoc context view, never persisted as a session
    out.length = err.length = 0
    expect(await run(['context', '--role', 'worker', '--focus', child.id], io)).toBe(0)
    const text = out.join('\n')
    expect(text).toMatch(/^<hafiz hash="[0-9a-f]{12}" role="worker">/)
    expect(text).toContain(`## Billing [${child.id}] planned · focus`)
    expect(err.join('\n')).toMatch(/tokens · 2 blocks · hash/)
    out.length = 0
    expect(
      await run(['context', '--role', 'worker', '--focus', child.id, '--explain', child.id], io),
    ).toBe(0)
    expect(out.join('\n')).toContain('rule 2 { relation: focus } → FULL')
    expect(await run(['context'], io)).toBe(1)
    const check = new FsBackend({ dir: storeDir, minorBatchSeconds: 0 })
    await check.open()
    expect(await check.read.listSessions()).toEqual([])
    await check.close()

    out.length = 0
    expect(await run(['history', child.id, 'design', '--json'], io)).toBe(0)
    const hist = JSON.parse(out.join('\n')) as Array<{ commit: string; author: string }>
    expect(hist.length).toBeGreaterThanOrEqual(2)
    expect(hist[0]?.author).toBe(`user/${me.agent}`)
    out.length = 0
    await run(['history', child.id], io)
    expect(out[0]).toMatch(/^[0-9a-f]{7,40} \S+ user\//)

    // revert to the first design: the commit just before the latest
    const first = hist[1]?.commit as string
    out.length = err.length = 0
    expect(await run(['revert', child.id, 'design', first], io)).toBe(0)
    out.length = 0
    await run(['show', child.id], io)
    expect(out.join('\n')).toContain('first')
    expect(out.join('\n')).not.toContain('second')
    expect(await run(['revert', child.id, 'design', 'deadbeef'], io)).toBe(1)
  })

  it('tells the user to adopt when the store is gone, and adopt re-points with a new id', async () => {
    const cwd = repo()
    const storeRoot = tmp('hafiz-stores-')
    const { io, err } = harness(cwd, storeRoot)
    await init(io, 'Shop', { storeRoot })
    const pointerFile = join(cwd, '.git/hafiz/project.yaml')
    const before = readFileSync(pointerFile, 'utf8')
    const id = /id: (\S+)/.exec(before)?.[1] as string
    execFileSync('rm', ['-rf', join(storeRoot, id)])

    expect(await run(['init', 'Shop'], io)).toBe(1)
    expect(err.join('\n')).toContain('hafiz init --adopt')
    expect(await run(['init', 'Shop', '--adopt'], io)).toBe(0)
    const after = readFileSync(pointerFile, 'utf8')
    expect(/id: (\S+)/.exec(after)?.[1]).not.toBe(id)
    expect(existsSync(resolveProject(cwd, io.env).storeDir)).toBe(true)
  })

  it('fails cleanly outside a project', async () => {
    const dir = tmp('hafiz-none-')
    mkdirSync(join(dir, 'x'))
    const { io, err } = harness(join(dir, 'x'), dir)
    expect(await run(['tree'], io)).toBe(1)
    expect(err.join('\n')).toContain('hafiz init')
  })

  it('smoke: the built bin works', () => {
    const bin = join(import.meta.dirname, '../dist/bin.js')
    if (!existsSync(bin)) return // run `pnpm build` first
    const cwd = repo()
    const env = { ...process.env, HAFIZ_STORE_ROOT: tmp('hafiz-stores-') }
    const go = (...args: string[]) =>
      spawnSync('node', [bin, ...args], { cwd, env, encoding: 'utf8' })
    expect(go('init', 'Smoke').status).toBe(0)
    const t = go('tree')
    expect(t.status).toBe(0)
    expect(t.stdout).toMatch(/\[active\] smoke-[0-9a-f]+ — Smoke \(root\)/)
  })
})
