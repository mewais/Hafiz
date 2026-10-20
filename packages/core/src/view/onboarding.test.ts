// Brownfield onboarding: the project flag, the manager-only directive and its automatic end.
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
const mgr: Actor = { sessionId: 'm1', role: 'manager', agent: 'build' }
const des: Actor = { sessionId: 'd1', role: 'designer', agent: 'designer' }

async function project(onboarding: boolean) {
  const core = new Core({ config, backend: new MemoryBackend(), clock: fixedClock() })
  const { result } = await core.projectInit(mgr, {
    name: 'Legacy',
    originFingerprint: 'fp',
    id: 'prj_legacy',
    ...(onboarding ? { onboarding } : {}),
  })
  const view = async (role: string) =>
    buildView(await loadSnapshot(core.backend.read), config, estimatorTokenizer, {
      role,
      focus: { blocks: [result.root.id], computed: false },
    })
  return { core, root: result.root, view }
}

describe('brownfield onboarding', () => {
  it('pending: the manager view carries the directive, other roles do not', async () => {
    const { core, root, view } = await project(true)
    expect((await core.backend.read.getProject())?.onboarding).toBe('pending')
    const v = await view('manager')
    // the root id is random: pin it (and the hash it feeds) for the golden
    const golden = viewGolden(v)
      .split(root.id)
      .join('legacy')
      .replace(/hash="[0-9a-f]{12}"/, 'hash="<hash>"')
    expectGolden('onboarding-manager-pending.md', golden)
    expect(v.text).toContain(`spawn the designer once with hafiz:block=${root.id}`)
    expect(v.text).toContain('Import what you touch, stub what you call')
    for (const role of ['designer', 'worker', 'planner'])
      expect((await view(role)).text).not.toContain('Onboarding:')
  })

  it('the first root design completes it: flag cleared, decision recorded, directive gone', async () => {
    const { core, root, view } = await project(true)
    await core.docWrite(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A Rails monolith with a React front end.', topology: ['web → api'] },
    })
    const p = await core.backend.read.getProject()
    expect(p?.onboarding).toBeUndefined()
    const decisions = await core.backend.read.readLog(root.id, 'decisions')
    expect(decisions.map((d) => d.entry.title)).toEqual(['Onboarded existing codebase'])
    expect(decisions[0]?.entry.by).toMatchObject({ role: 'designer' })
    expect((await view('manager')).text).not.toContain('Onboarding:')
    // later root designs record nothing more
    await core.docPatch(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A Rails monolith with a React front end and a job queue.' },
    })
    expect(await core.backend.read.readLog(root.id, 'decisions')).toHaveLength(1)
  })

  it('greenfield: no flag, no directive, nothing recorded on the first root design', async () => {
    const { core, root, view } = await project(false)
    expect((await core.backend.read.getProject())?.onboarding).toBeUndefined()
    expect((await view('manager')).text).not.toContain('Onboarding:')
    await core.docWrite(des, {
      block: root.id,
      type: 'design',
      sections: { overview: 'A new CLI.', topology: ['cli → core'] },
    })
    expect(await core.backend.read.readLog(root.id, 'decisions')).toHaveLength(0)
  })
})
