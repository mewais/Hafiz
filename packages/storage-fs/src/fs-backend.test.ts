import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Actor, Core, loadConfig } from '@hafiz/core'
import { block, conformance } from '@hafiz/core/conformance'
import { describe, expect, it } from 'vitest'
import { FsBackend } from './fs-backend.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'hafiz-fs-'))
const by: Actor = { sessionId: 's1', role: 'manager', agent: 'mgr' }

conformance('fs (git)', async () => {
  const b = new FsBackend({ dir: tmp(), minorBatchSeconds: 0 })
  await b.open()
  return b
})

describe('fs backend specifics', () => {
  it('persists human-readable files and reloads the same state', async () => {
    const dir = tmp()
    const a = new FsBackend({ dir, minorBatchSeconds: 0 })
    await a.open()
    await a.tx({ by, command: 'block.create', major: true }, async (t) => {
      await t.putBlock(block('root'), -1)
      await t.putDoc(
        {
          blockId: 'root',
          type: 'design',
          version: 1,
          updatedAt: 't',
          by,
          sections: { overview: 'A shop.\n\nTwo lines.', topology: ['web → api', 'api → db'] },
        },
        0,
      )
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
    await a.close()
    const md = readFileSync(join(dir, 'blocks/root/design.md'), 'utf8')
    expect(md).toContain('## overview\n\nA shop.\n\nTwo lines.')
    expect(md).toContain('## topology\n\n```yaml\n- web → api')
    const b = new FsBackend({ dir, minorBatchSeconds: 0 })
    await b.open()
    expect((await b.read.getDoc('root', 'design'))?.sections).toEqual({
      overview: 'A shop.\n\nTwo lines.',
      topology: ['web → api', 'api → db'],
    })
    expect((await b.read.readLog('root', 'progress')).length).toBe(1)
    expect(await b.read.currentSeq()).toBe(1)
    const h = await b.read.history('root', 'design')
    expect(h[0]?.author).toBe('manager/mgr')
    await b.close()
  })

  it('replays a journal left behind by a crash', async () => {
    const dir = tmp()
    const a = new FsBackend({ dir, minorBatchSeconds: 0 })
    await a.open()
    await a.close()
    mkdirSync(join(dir, '.journal'), { recursive: true })
    writeFileSync(
      join(dir, '.journal/1.json'),
      JSON.stringify({
        writes: {
          'blocks/x/block.yaml':
            'id: x\nparentId: null\ntitle: X\nkind: root\nstatus: planned\norder: 0\nversion: 0\ndocVersions: { design: 0, plan: 0, digest: 0 }\ncreatedAt: t\nupdatedAt: t\n',
        },
        deletes: [],
      }),
    )
    const b = new FsBackend({ dir, minorBatchSeconds: 0 })
    await b.open()
    expect((await b.read.getBlock('x'))?.title).toBe('X')
    expect(existsSync(join(dir, '.journal/1.json'))).toBe(false)
    await b.close()
  })

  it('detects hand edits as dirty', async () => {
    const dir = tmp()
    const a = new FsBackend({ dir, minorBatchSeconds: 0 })
    await a.open()
    await a.tx({ by, command: 'x', major: true }, async (t) => t.putBlock(block('root'), -1))
    expect(await a.dirty()).toEqual([])
    writeFileSync(join(dir, 'blocks/root/block.yaml'), 'tampered\n')
    expect(await a.dirty()).toEqual(['blocks/root/block.yaml'])
    await a.close()
  })
})

describe('core over fs backend', () => {
  it('warns when store files were hand edited', async () => {
    const dir = tmp()
    const backend = new FsBackend({ dir, minorBatchSeconds: 0 })
    await backend.open()
    const core = new Core({ config: loadConfig(), backend })
    const user: Actor = { sessionId: 'cli', role: 'user', agent: 'me' }
    const init = await core.projectInit(user, { name: 'Shop', originFingerprint: 'fp' })
    expect(init.notices).toEqual([])
    const root = init.result.root.id
    appendFileSync(join(dir, `blocks/${root}/block.yaml`), '# hand edit\n')
    const r = await core.blockCreate(user, { parent: root, title: 'Billing' })
    expect(
      r.notices.some((n) => n.level === 'warn' && n.text.includes(`blocks/${root}/block.yaml`)),
    ).toBe(true)
    const r2 = await core.blockCreate(user, { parent: root, title: 'Other' })
    expect(r2.notices.some((n) => n.text.includes('edited outside Hafiz'))).toBe(false)
    await backend.close()
  })
})
