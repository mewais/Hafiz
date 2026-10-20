import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Actor, Core, loadConfig } from '@hafiz/core'
import { block, conformance } from '@hafiz/core/conformance'
import { describe, expect, it } from 'vitest'
import { SqliteBackend } from './sqlite-backend.js'

const tmp = () => join(mkdtempSync(join(tmpdir(), 'hafiz-sqlite-')), 'hafiz.sqlite')
const by: Actor = { sessionId: 's1', role: 'manager', agent: 'mgr' }

conformance('sqlite', async () => {
  const b = new SqliteBackend({ file: tmp() })
  await b.open()
  return b
})

describe('sqlite backend specifics', () => {
  it('reloads the same state, including logs and doc history', async () => {
    const file = tmp()
    const a = new SqliteBackend({ file })
    await a.open()
    const doc = (v: number, text: string) => ({
      blockId: 'root',
      type: 'design' as const,
      version: v,
      updatedAt: `2026-01-0${v}T00:00:00.000Z`,
      by,
      sections: { overview: text },
    })
    const first = await a.tx({ by, command: 'block.create', major: true }, async (t) => {
      await t.putBlock(block('root'), -1)
      await t.putDoc(doc(1, 'one'), 0)
      await t.appendLog('root', 'progress', {
        id: 'p1',
        blockId: 'root',
        ts: 't',
        by,
        kind: 'found',
        text: 'x',
        refs: [],
      })
    })
    await a.tx({ by, command: 'doc.write', major: true, message: 'second' }, async (t) =>
      t.putDoc(doc(2, 'two'), 1),
    )
    await a.close()

    const b = new SqliteBackend({ file })
    await b.open()
    expect((await b.read.getDoc('root', 'design'))?.sections).toEqual({ overview: 'two' })
    expect((await b.read.readLog('root', 'progress')).length).toBe(1)
    const h = await b.read.history('root', 'design')
    expect(h.map((e) => e.message)).toEqual(['second', 'block.create'])
    expect(h[0]?.author).toBe('manager/mgr')
    expect((await b.read.docAt('root', 'design', first.commit as string))?.sections).toEqual({
      overview: 'one',
    })
    // A new write after reload appends to history and logs rather than duplicating them.
    await b.tx({ by, command: 'doc.write', major: true, message: 'third' }, async (t) => {
      await t.putDoc(doc(3, 'three'), 2)
      await t.appendLog('root', 'progress', {
        id: 'p2',
        blockId: 'root',
        ts: 't',
        by,
        kind: 'found',
        text: 'y',
        refs: [],
      })
    })
    await b.close()
    const c = new SqliteBackend({ file })
    await c.open()
    expect((await c.read.history('root', 'design')).length).toBe(3)
    expect((await c.read.readLog('root', 'progress')).map((r) => r.seq)).toEqual([1, 2])
    await c.close()
  })

  it('rolls back a failed transaction completely', async () => {
    const file = tmp()
    const a = new SqliteBackend({ file })
    await a.open()
    await expect(
      a.tx({ by, command: 'x', major: true }, async (t) => {
        await t.putBlock(block('root'), -1)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    await a.close()
    const b = new SqliteBackend({ file })
    await b.open()
    expect(await b.read.listBlocks()).toEqual([])
    await b.close()
  })

  it('runs Core end to end', async () => {
    const backend = new SqliteBackend({ file: tmp() })
    await backend.open()
    const core = new Core({ config: loadConfig(), backend })
    const user: Actor = { sessionId: 'cli', role: 'user', agent: 'me' }
    const init = await core.projectInit(user, { name: 'Shop', originFingerprint: 'fp' })
    await core.blockCreate(user, { parent: init.result.root.id, title: 'Billing' })
    expect((await core.treeList(user)).length).toBe(2)
    await backend.close()
  })
})
