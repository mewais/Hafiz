// Backend conformance suite. Every StorageBackend must pass it unchanged.
import { describe, expect, it } from 'vitest'
import { ConflictError } from '../domain/errors.js'
import type { Actor, Block, Doc, Project, Thread } from '../domain/types.js'
import type { StorageBackend } from './backend.js'

const by: Actor = { sessionId: 's1', role: 'manager', agent: 'mgr' }
const meta = (command = 'test', major = true) => ({ by, command, major })

export function block(
  id: string,
  parentId: string | null = null,
  extra: Partial<Block> = {},
): Block {
  return {
    id,
    parentId,
    title: id,
    kind: parentId ? 'component' : 'root',
    status: 'planned',
    order: 0,
    version: 0,
    docVersions: { design: 0, plan: 0, digest: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }
}

export function conformance(name: string, make: () => Promise<StorageBackend>) {
  describe(`storage conformance: ${name}`, () => {
    it('project round-trips', async () => {
      const s = await make()
      const p: Project = {
        id: 'p',
        name: 'P',
        originFingerprint: 'f',
        rootBlockId: 'root',
        schemaSetVersion: 'default',
        epoch: 0,
        createdAt: 'now',
      }
      await s.tx(meta(), async (t) => t.putProject(p))
      expect(await s.read.getProject()).toEqual(p)
      await s.close()
    })

    it('blocks: create requires -1, update requires current version, conflicts carry current', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => t.putBlock(block('a'), -1))
      await expect(s.tx(meta(), async (t) => t.putBlock(block('a'), -1))).rejects.toBeInstanceOf(
        ConflictError,
      )
      await s.tx(meta(), async (t) => t.putBlock({ ...block('a'), title: 'A2', version: 1 }, 0))
      const err = await s
        .tx(meta(), async (t) => t.putBlock({ ...block('a'), version: 1 }, 0))
        .catch((e) => e)
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).details.actual).toBe(1)
      expect((err as ConflictError).details.current).toMatchObject({ title: 'A2' })
      expect((await s.read.listBlocks()).map((b) => b.title)).toEqual(['A2'])
      await s.close()
    })

    it('docs: CAS on version, history newest-first, docAt by commit', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => t.putBlock(block('a'), -1))
      const d1: Doc = {
        blockId: 'a',
        type: 'design',
        version: 1,
        sections: { purpose: 'v1' },
        updatedAt: 't1',
        by,
      }
      const r1 = await s.tx(meta('doc.write'), async (t) => t.putDoc(d1, 0))
      await s.tx(meta('doc.write'), async (t) =>
        t.putDoc({ ...d1, version: 2, sections: { purpose: 'v2' }, updatedAt: 't2' }, 1),
      )
      await expect(
        s.tx(meta(), async (t) => t.putDoc({ ...d1, version: 2 }, 1)),
      ).rejects.toBeInstanceOf(ConflictError)
      expect((await s.read.getDoc('a', 'design'))?.sections).toEqual({ purpose: 'v2' })
      const h = await s.read.history('a', 'design')
      expect(h.length).toBe(2)
      expect(h[0]?.author).toContain('manager')
      if (r1.commit)
        expect((await s.read.docAt('a', 'design', r1.commit))?.sections).toEqual({ purpose: 'v1' })
      await s.close()
    })

    it('logs: append returns increasing seq; last/sinceSeq/readSince work across logs', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => {
        await t.putBlock(block('a'), -1)
        await t.putBlock(block('b', 'a'), -1)
      })
      const seqs: number[] = []
      await s.tx(meta('progress.append', false), async (t) => {
        for (let i = 0; i < 3; i++)
          seqs.push(
            await t.appendLog('a', 'progress', {
              id: `p${i}`,
              blockId: 'a',
              ts: 't',
              by,
              kind: 'found',
              text: `f${i}`,
              refs: [],
            }),
          )
        seqs.push(
          await t.appendLog('b', 'steps', {
            blockId: 'b',
            stepId: 's1',
            status: 'done',
            ts: 't',
            by,
          }),
        )
      })
      expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
      expect(new Set(seqs).size).toBe(4)
      const last2 = await s.read.readLog('a', 'progress', { last: 2 })
      expect(last2.map((r) => r.entry.text)).toEqual(['f1', 'f2'])
      const since = await s.read.readLog('a', 'progress', { sinceSeq: seqs[0] as number })
      expect(since.length).toBe(2)
      const all = await s.read.readSince(0)
      expect(all.map((r) => r.log)).toEqual(['progress', 'progress', 'progress', 'steps'])
      expect(await s.read.currentSeq()).toBe(seqs[3])
      await s.close()
    })

    it('edges: idempotent put, delete', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => {
        await t.putEdge({ from: 'a', to: 'b', kind: 'depends_on' })
        await t.putEdge({ from: 'a', to: 'b', kind: 'depends_on' })
      })
      expect((await s.read.listEdges()).length).toBe(1)
      await s.tx(meta(), async (t) => t.deleteEdge({ from: 'a', to: 'b', kind: 'depends_on' }))
      expect((await s.read.listEdges()).length).toBe(0)
      await s.close()
    })

    it('threads, sessions (by token), proposals, audit', async () => {
      const s = await make()
      const th: Thread = {
        id: 'thr1',
        blockId: 'a',
        title: 'T',
        status: 'open',
        entries: [],
        createdAt: 't',
        updatedAt: 't',
        by,
      }
      await s.tx(meta('thread.open', false), async (t) => {
        await t.putThread(th)
        await t.putSession({
          id: 'sess',
          projectId: 'p',
          host: 'test',
          role: 'worker',
          token: 'tok',
          focus: { blocks: [], computed: true },
          counters: {},
          createdAt: 't',
          updatedAt: 't',
        })
        await t.putProposal({
          id: 'pr1',
          kind: 'status',
          source: 'compliance',
          payload: { command: 'x', args: {} },
          status: 'pending',
          createdAt: 't',
        })
        await t.appendAudit({ ts: 't', by, command: 'thread.open', target: 'a' })
      })
      expect((await s.read.listThreads('a')).map((x) => x.id)).toEqual(['thr1'])
      expect((await s.read.getSessionByToken('tok'))?.id).toBe('sess')
      expect((await s.read.listProposals({ status: 'pending' })).length).toBe(1)
      expect((await s.read.readAudit({ last: 1 }))[0]?.command).toBe('thread.open')
      expect((await s.read.readSince(0)).some((r) => r.log === 'threads')).toBe(true)
      await s.close()
    })

    it('tx is atomic: a throw after writes persists nothing', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => t.putBlock(block('a'), -1))
      await expect(
        s.tx(meta(), async (t) => {
          await t.putBlock(block('b', 'a'), -1)
          await t.appendLog('a', 'progress', {
            id: 'p',
            blockId: 'a',
            ts: 't',
            by,
            kind: 'found',
            text: 'x',
            refs: [],
          })
          throw new Error('boom')
        }),
      ).rejects.toThrow('boom')
      expect((await s.read.listBlocks()).map((b) => b.id)).toEqual(['a'])
      expect((await s.read.readLog('a', 'progress')).length).toBe(0)
      await s.close()
    })

    it('concurrent transactions are serialised and all appends survive', async () => {
      const s = await make()
      await s.tx(meta(), async (t) => t.putBlock(block('a'), -1))
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          s.tx(meta('progress.append', false), async (t) => {
            await t.appendLog('a', 'progress', {
              id: `p${i}`,
              blockId: 'a',
              ts: 't',
              by,
              kind: 'found',
              text: `${i}`,
              refs: [],
            })
          }),
        ),
      )
      const rows = await s.read.readLog('a', 'progress')
      expect(rows.length).toBe(20)
      expect(new Set(rows.map((r) => r.seq)).size).toBe(20)
      await s.close()
    })
  })
}
