// Brownfield onboarding: the project flag, the manager's and the designer's directives and its
// automatic end.
import { describe, expect, it } from 'vitest'
import { Core } from '../commands/core.js'
import { loadConfig } from '../config/load.js'
import { fixedClock } from '../domain/clock.js'
import type { Actor } from '../domain/types.js'
import { MemoryBackend } from '../store/memory.js'
import { estimatorTokenizer } from '../tokenizer.js'
import { buildView } from './engine.js'
import { expectGolden, viewGolden } from './fixtures/golden.js'
import { loadSnapshot } from './snapshot.js'

const config = loadConfig()
const MGR = 'Onboarding is due: the next designer you spawn writes the root design first.'
const DES = 'Onboarding: this repo had code before Hafiz tracked it. Write the root design first'
const mgr: Actor = { sessionId: 'm1', role: 'manager', agent: 'build' }
const pln: Actor = { sessionId: 'p1', role: 'planner', agent: 'planner' }
const des: Actor = { sessionId: 'd1', role: 'designer', agent: 'designer' }

async function project(onboarding: boolean) {
  const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
  const { result } = await core.projectInit(mgr, {
    name: 'Legacy',
    originFingerprint: 'fp',
    id: 'prj_legacy',
    ...(onboarding ? { onboarding } : {}),
  })
  const view = async (role: string, on = result.root.id) =>
    buildView(await loadSnapshot(core.backend.read), config, estimatorTokenizer, {
      role,
      focus: { blocks: [on], computed: false },
    })
  return { core, root: result.root, view }
}

describe('brownfield onboarding', () => {
  it('pending until tracked work starts: no directive for a one-off fix', async () => {
    const { core, view } = await project(true)
    expect((await core.backend.read.getProject())?.onboarding).toBe('pending')
    expect((await view('manager')).text).not.toContain(MGR)
    // sessions without a spawn block, and a user-opened one, are not tracked work
    await core.sessionOpen({ id: 'm1', host: 'test', role: 'manager' })
    await core.sessionOpen({ id: 'u1', host: 'test', role: 'user', spawnedBlock: 'whatever' })
    expect((await core.backend.read.getProject())?.onboarding).toBe('pending')
  })

  it('block.create makes it due', async () => {
    const { core, root, view } = await project(true)
    const { result: pay } = await core.blockCreate(mgr, { parent: root.id, title: 'Payments' })
    expect((await core.backend.read.getProject())?.onboarding).toBe('due')
    expect((await view('manager')).text).toContain(MGR)
    // a designer spawned on the feature block is the one that onboards: no spawn on the root
    expect((await view('designer', pay.id)).text).toContain(DES)
  })

  it('a session opened on a block by a non-user role makes it due', async () => {
    const { core, root, view } = await project(true)
    await core.sessionOpen({ id: 'd1', host: 'test', role: 'designer', spawnedBlock: root.id })
    expect((await core.backend.read.getProject())?.onboarding).toBe('due')
    expect((await view('manager')).text).toContain(MGR)
  })

  it('a non-design doc write on the root makes it due', async () => {
    const { core, root } = await project(true)
    await core.docWrite(pln, {
      block: root.id,
      type: 'plan',
      sections: { steps: [{ id: 's1', title: 'x' }], acceptance: ['y'] },
    })
    expect((await core.backend.read.getProject())?.onboarding).toBe('due')
  })

  it('due: the manager and the designer carry their directives, other roles none', async () => {
    const { core, root, view } = await project(true)
    await core.docWrite(pln, {
      block: root.id,
      type: 'plan',
      sections: { steps: [{ id: 's1', title: 'x' }], acceptance: ['y'] },
    })
    const v = await view('manager')
    // the root id is random: pin it (and the hash it feeds) for the golden
    const golden = viewGolden(v)
      .split(root.id)
      .join('legacy')
      .replace(/hash="[0-9a-f]{12}"/, 'hash="<hash>"')
    expectGolden('onboarding-manager-pending.md', golden)
    // one line each: the manager spawns no separate designer, the next one writes the root first
    expect(v.text).toContain(MGR)
    expect(v.text).not.toContain(DES)
    const d = (await view('designer')).text
    expect(d.split('\n')[1]).toContain(DES) // the top of its view, whatever block it is on
    expect(d).toContain('then your block.')
    for (const role of ['worker', 'planner']) {
      expect((await view(role)).text).not.toContain(MGR)
      expect((await view(role)).text).not.toContain(DES)
    }
  })

  it('the first root design completes it: flag cleared, progress entry (no decision), directive gone', async () => {
    const { core, root, view } = await project(true)
    await core.blockCreate(mgr, { parent: root.id, title: 'Payments' })
    expect((await view('manager')).text).toContain(MGR)
    expect((await view('designer')).text).toContain(DES)
    await core.docWrite(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A Rails monolith with a React front end.', topology: ['web → api'] },
    })
    const p = await core.backend.read.getProject()
    expect(p?.onboarding).toBeUndefined()
    // Hafiz never records a decision of its own
    expect(await core.backend.read.readLog(root.id, 'decisions')).toHaveLength(0)
    const progress = await core.backend.read.readLog(root.id, 'progress')
    expect(progress.map((p) => [p.entry.kind, p.entry.text])).toEqual([
      ['changed', expect.stringContaining('Onboarded existing codebase')],
    ])
    expect(progress[0]?.entry.by).toMatchObject({ role: 'designer' })
    expect((await view('manager')).text).not.toContain(MGR)
    expect((await view('designer')).text).not.toContain(DES)
    // later root designs record nothing more
    await core.docPatch(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A Rails monolith with a React front end and a job queue.' },
    })
    expect(await core.backend.read.readLog(root.id, 'progress')).toHaveLength(1)
    expect(await core.backend.read.readLog(root.id, 'decisions')).toHaveLength(0)
  })

  it('greenfield: no flag, no directive, nothing recorded on the first root design', async () => {
    const { core, root, view } = await project(false)
    expect((await core.backend.read.getProject())?.onboarding).toBeUndefined()
    expect((await view('manager')).text).not.toContain(MGR)
    await core.docWrite(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A new CLI.', topology: ['cli → core'] },
    })
    expect(await core.backend.read.readLog(root.id, 'decisions')).toHaveLength(0)
  })
})
