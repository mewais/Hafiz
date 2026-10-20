import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Actor, Core, loadConfig, readPointer, resolveProject } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
import { describe, expect, it } from 'vitest'
import { type Io, run, userActor } from './commands.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const V2 = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'schema-v2')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  })

function repo() {
  const dir = tmp('hafiz-repo-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'x\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function harness(cwd: string, extra: Record<string, string> = {}) {
  const out: string[] = []
  const err: string[] = []
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    HAFIZ_HOME: tmp('hafiz-home-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
    HOME: tmp('hafiz-userhome-'),
    ...extra,
  }
  delete env.XDG_CONFIG_HOME
  const io: Io = { cwd, env, out: (l) => out.push(l), err: (l) => err.push(l) }
  const clear = () => {
    out.length = err.length = 0
  }
  return { io, out, err, clear }
}

const design = (purpose: string, extra: Record<string, unknown> = {}) => ({
  purpose,
  scope: ['in: x', 'out: y'],
  interface: { provides: [{ name: 'f()', type: 'fn' }], consumes: [] },
  ...extra,
})

/** Open the project's store directly, as a tool (not the daemon) would, to seed data. */
async function seed<T>(io: Io, fn: (core: Core, root: string) => Promise<T>, repoDir?: string) {
  const { storeDir, worktree } = resolveProject(io.cwd, io.env)
  const backend = new FsBackend({ dir: storeDir, minorBatchSeconds: 0 })
  await backend.open()
  const core = new Core({ config: loadConfig(), backend, repoDir: repoDir ?? worktree })
  try {
    return await fn(core, (await backend.read.getProject())?.rootBlockId as string)
  } finally {
    await backend.close()
  }
}

describe('hafiz migrate and doctor: a real schema change', () => {
  it('flags old docs, plans a dry run, migrates as the user, and keeps reads working', async () => {
    const cwd = repo()
    const { io, out, err, clear } = harness(cwd)
    expect(await run(['init', 'Shop'], io)).toBe(0)
    const { storeDir } = resolveProject(cwd, io.env)
    const blocks = await seed(io, async (core, root) => {
      const me = userActor()
      const comp = (await core.blockCreate(me, { parent: root, title: 'Billing' })).result
      const feat = (
        await core.blockCreate(me, { parent: root, title: 'Invoices', kind: 'feature' })
      ).result
      for (const b of [comp, feat])
        await core.docWrite(me, {
          block: b.id,
          type: 'design',
          sections: design(`${b.title} purpose`, { references: [{ label: 'a', ref: 'b' }] }),
        })
      return { comp: comp.id, feat: feat.id }
    })

    // v1 store, v1 schema: healthy
    clear()
    expect(await run(['doctor'], io)).toBe(0)
    expect(out.join('\n')).toContain('doctor: healthy')
    expect(await run(['migrate'], io)).toBe(0)
    expect(out.join('\n')).toContain('nothing to migrate')

    // ship schema set v2 as the store's config layer
    cpSync(V2, join(storeDir, 'config'), { recursive: true })

    // doctor flags the docs; reads do not crash
    clear()
    expect(await run(['doctor'], io)).toBe(1)
    const report = out.join('\n')
    expect(report).toMatch(/FAIL schema\s+project pins schema set 1, the loaded set is 2/)
    expect(report).toContain(`${blocks.comp} design: unknown section(s): scope, references`)
    clear()
    expect(await run(['show', blocks.comp], io)).toBe(0)
    expect(out.join('\n')).toContain('Billing purpose')
    expect(await run(['tree'], io)).toBe(0)
    expect(await run(['context', '--role', 'manager'], io)).toBe(0)

    // dry run: a plan, no writes
    clear()
    expect(await run(['migrate', '--dry-run'], io)).toBe(0)
    const plan = out.join('\n')
    expect(plan).toContain('schema set 1 → 2 (migrations/1-2.yaml)')
    expect(plan).toContain(
      `${blocks.comp} design: rename scope → boundaries, add owner, drop references`,
    )
    expect(plan).toContain(
      `${blocks.feat} design: rename scope → boundaries, add owner, drop references, schema component-design → feature-design`,
    )
    expect(plan).toContain('dry run: nothing written')
    expect(await run(['doctor'], io)).toBe(1)

    // apply
    clear()
    expect(await run(['migrate'], io)).toBe(0)
    expect(out.join('\n')).toContain('migrated 2 doc(s)')
    await seed(io, async (core) => {
      const p = await core.backend.read.getProject()
      expect(p?.schemaSetVersion).toBe('2')
      const d = await core.backend.read.getDoc(blocks.comp, 'design')
      expect(Object.keys(d?.sections ?? {})).toEqual([
        'purpose',
        'boundaries',
        'interface',
        'owner',
      ])
      expect(d?.sections.owner).toBe('unassigned')
      expect(d?.sections.boundaries).toEqual(['in: x', 'out: y'])
      expect(d?.by).toMatchObject({ role: 'user' })
      const h = await core.backend.read.history(blocks.comp, 'design')
      expect(h[0]?.author).toBe(`user/${userActor().agent}`)
      expect(h[0]?.message).toContain('migrate schema set to version 2')
    })
    clear()
    expect(await run(['doctor'], io)).toBe(0)
    expect(out.join('\n')).toMatch(/ok\s+schema\s+2 doc\(s\) satisfy schema set 2/)
    expect(await run(['migrate'], io)).toBe(0)
    expect(out.join('\n')).toContain('nothing to migrate')
    expect(err).toEqual([])
  })

  it('refuses to migrate while a doc would fail the new schema, writing nothing', async () => {
    const cwd = repo()
    const { io, out, err, clear } = harness(cwd)
    await run(['init', 'Shop'], io)
    const { storeDir } = resolveProject(cwd, io.env)
    await seed(io, async (core, root) => {
      const b = (await core.blockCreate(userActor(), { parent: root, title: 'Billing' })).result
      await core.docWrite(userActor(), { block: b.id, type: 'design', sections: design('p') })
    })
    cpSync(V2, join(storeDir, 'config'), { recursive: true })
    // owner is capped at 30 tokens in v2, but the migration inserts a longer default
    const mig = join(storeDir, 'config/migrations/1-2.yaml')
    writeFileSync(
      mig,
      readFileSync(mig, 'utf8').replace('default: unassigned', `default: "${'owner '.repeat(80)}"`),
    )
    clear()
    expect(await run(['migrate'], io)).toBe(1)
    expect(err.join('\n')).toContain('would not satisfy the new schema')
    clear()
    await run(['doctor'], io)
    expect(out.join('\n')).toContain('project pins schema set 1')
  })
})

describe('hafiz doctor: drift and wiring', () => {
  it('records the repo HEAD at done and lists files changed under the digest pointers since', async () => {
    const cwd = repo()
    const { io, out, clear } = harness(cwd)
    await run(['init', 'Shop'], io)
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/billing.ts'), 'v1\n')
    writeFileSync(join(cwd, 'src/other.ts'), 'v1\n')
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'billing')
    const head = git(cwd, 'rev-parse', 'HEAD').trim()
    const id = await seed(io, async (core, root) => {
      const me = userActor()
      const b = (await core.blockCreate(me, { parent: root, title: 'Billing' })).result
      await core.blockSetStatus(me, { id: b.id, status: 'active' })
      await core.blockSetStatus(me, {
        id: b.id,
        status: 'done',
        digest: {
          outcome: 'Billing is implemented with invoices and retries in the billing module.',
          interface_delta: ['none'],
          pointers: [
            { label: 'code', ref: 'src/billing.ts:12' },
            { label: 'pr', ref: '#57' },
          ],
        },
      })
      expect((await core.backend.read.getBlock(b.id))?.doneAt?.commit).toBe(head)
      return b.id
    })

    clear()
    expect(await run(['doctor'], io)).toBe(0)
    expect(out.join('\n')).toMatch(/ok\s+drift\s+1 done block\(s\) checked, no drift/)

    writeFileSync(join(cwd, 'src/other.ts'), 'v2\n')
    git(cwd, 'commit', '-qam', 'unrelated')
    clear()
    await run(['doctor'], io)
    expect(out.join('\n')).toMatch(/no drift/)

    writeFileSync(join(cwd, 'src/billing.ts'), 'v2\n')
    git(cwd, 'commit', '-qam', 'touch billing')
    clear()
    expect(await run(['doctor'], io)).toBe(0)
    const text = out.join('\n')
    expect(text).toMatch(/warn\s+drift\s+1 done block\(s\) have changed files/)
    expect(text).toContain(`${id}: src/billing.ts changed since ${head.slice(0, 8)}`)
    expect(text).not.toContain('other.ts')
  })

  it('reports pointer mismatch, dirty stores, stale daemon locks and Kilo wiring', async () => {
    const cwd = repo()
    const { io, out, clear } = harness(cwd)
    await run(['init', 'Shop'], io)
    const { storeDir, pointerFile } = resolveProject(cwd, io.env)

    clear()
    await run(['doctor'], io)
    expect(out.join('\n')).toMatch(/ok\s+pointer\s+prj_\w+ matches the store fingerprint/)
    expect(out.join('\n')).toMatch(/warn\s+kilo\s+plugin not found in Kilo config/)
    expect(out.join('\n')).toMatch(/-\s+condenser\s+not configured/)

    // hand edit
    writeFileSync(join(storeDir, 'edges.yaml'), 'edges: []\n# hand edit\n')
    // stale lock from a dead pid
    writeFileSync(join(storeDir, '.lock'), JSON.stringify({ pid: 2 ** 22 + 1, socket: '' }))
    clear()
    expect(await run(['doctor'], io)).toBe(0)
    expect(out.join('\n')).toMatch(/warn\s+store\s+1 file\(s\) edited outside Hafiz/)
    expect(out.join('\n')).toContain('edges.yaml')
    expect(out.join('\n')).toMatch(/warn\s+daemon\s+stale lock/)

    // wrong fingerprint in the pointer
    const p = readPointer(pointerFile)
    writeFileSync(pointerFile, `id: ${p.id}\nfingerprint: 0000000000000000\nstore: ${p.store}\n`)
    clear()
    expect(await run(['doctor', '--json'], io)).toBe(1)
    const json = JSON.parse(out.join('\n')) as {
      ok: boolean
      checks: Array<{ name: string; level: string }>
    }
    expect(json.ok).toBe(false)
    expect(json.checks.find((c) => c.name === 'pointer')?.level).toBe('fail')

    // no project at all
    const bare = harness(tmp('hafiz-bare-'))
    expect(await run(['doctor'], bare.io)).toBe(1)
    expect(bare.out.join('\n')).toContain('no Hafiz project here')
  })

  it('--online tests the condenser provider', async () => {
    const cwd = repo()
    const { io, out, clear } = harness(cwd)
    await run(['init', 'Shop'], io)
    const { storeDir } = resolveProject(cwd, io.env)
    mkdirSync(join(storeDir, 'config'), { recursive: true })
    writeFileSync(
      join(storeDir, 'config/hafiz.yaml'),
      'llm:\n  condenser: { provider: fake, model: m }\n',
    )
    clear()
    await run(['doctor'], io)
    expect(out.join('\n')).toContain('run with --online')
    clear()
    expect(await run(['doctor', '--online'], io)).toBe(0)
    expect(out.join('\n')).toMatch(/ok\s+condenser\s+fake\/m answered/)
    writeFileSync(
      join(storeDir, 'config/hafiz.yaml'),
      'llm:\n  condenser: { provider: openai-compatible, model: m, base_url: "http://127.0.0.1:9", api_key_env: NOPE }\n',
    )
    clear()
    expect(await run(['doctor', '--online'], io)).toBe(1)
    expect(out.join('\n')).toMatch(/FAIL condenser/)
  })
})

describe('hafiz export / import and the sqlite backend', () => {
  it('round-trips fs -> export -> import into sqlite with identical context output', async () => {
    const a = harness(repo())
    expect(await run(['init', 'Shop'], a.io)).toBe(0)
    await seed(a.io, async (core, root) => {
      const me = userActor()
      const worker: Actor = { sessionId: 'w1', role: 'worker', agent: 'w' }
      const auth = (await core.blockCreate(me, { parent: root, title: 'Auth' })).result
      const pay = (await core.blockCreate(me, { parent: root, title: 'Payments' })).result
      await core.docWrite(me, {
        block: auth.id,
        type: 'design',
        sections: design('Login and sessions'),
      })
      await core.docWrite(me, { block: pay.id, type: 'design', sections: design('Charge cards') })
      await core.docWrite(me, {
        block: pay.id,
        type: 'design',
        sections: design('Charge cards, v2'),
      })
      await core.edgeAdd(me, { from: pay.id, to: auth.id, kind: 'depends_on' })
      await core.blockSetStatus(me, { id: pay.id, status: 'active' })
      await core.progressAppend(worker, {
        block: pay.id,
        kind: 'found',
        text: 'Stripe needs idempotency keys.',
      })
      await core.decisionRecord(me, {
        block: pay.id,
        title: 'Cards only',
        decision: 'No bank transfers in v1.',
        standing: 'never',
      })
      await core.threadOpen(me, { block: pay.id, title: 'Refund policy', text: 'who decides?' })
    })
    const file = join(tmp('hafiz-export-'), 'shop.json')
    expect(await run(['export', file], a.io)).toBe(0)
    const snap = JSON.parse(readFileSync(file, 'utf8'))
    expect(snap.format).toBe('hafiz-snapshot')
    expect(JSON.stringify(snap)).not.toContain('"token"') // no sessions
    expect(snap.blocks).toHaveLength(3)

    const focusId = (await (async () => {
      a.clear()
      await run(['tree', '--json'], a.io)
      return (JSON.parse(a.out.join('\n')) as Array<{ id: string; title: string }>).find(
        (b) => b.title === 'Payments',
      )?.id
    })()) as string
    const args = ['context', '--role', 'manager', '--focus', focusId]
    a.clear()
    await run(args, a.io)
    const original = a.out.join('\n')
    expect(original).toContain('Charge cards, v2')

    // import into a fresh repo as sqlite
    const b = harness(repo())
    expect(await run(['import', file, '--backend', 'sqlite'], b.io)).toBe(0)
    const { storeDir, pointer } = resolveProject(b.io.cwd, b.io.env)
    expect(existsSync(join(storeDir, 'hafiz.sqlite'))).toBe(true)
    expect(existsSync(join(storeDir, '.git'))).toBe(false)
    expect(pointer.id).toBe(snap.project.id)
    b.clear()
    await run(args, b.io)
    expect(b.out.join('\n')).toBe(original)
    for (const role of ['worker', 'designer']) {
      a.clear()
      await run(['context', '--role', role, '--focus', focusId], a.io)
      b.clear()
      await run(['context', '--role', role, '--focus', focusId], b.io)
      expect(b.out.join('\n')).toBe(a.out.join('\n'))
    }

    // the sqlite store works as a normal store afterwards, history included
    b.clear()
    expect(await run(['history', focusId, 'design'], b.io)).toBe(0)
    expect(b.out.length).toBeGreaterThanOrEqual(1)
    b.clear()
    expect(await run(['doctor'], b.io)).toBe(0)
    expect(b.out.join('\n')).toContain('clean (sqlite backend)')

    // a second import refuses: the store is no longer empty
    b.clear()
    expect(await run(['import', file], b.io)).toBe(1)
    expect(b.err.join('\n')).toContain('not empty')

    // --as-new mints a new id and fingerprint
    const c = harness(repo())
    expect(await run(['import', file, '--as-new'], c.io)).toBe(0)
    const np = resolveProject(c.io.cwd, c.io.env).pointer
    expect(np.id).not.toBe(snap.project.id)
    expect(np.fingerprint).not.toBe(snap.project.originFingerprint)
    c.clear()
    await run(args, c.io)
    expect(c.out.join('\n').replace(/hash="[0-9a-f]+"/, '')).toBe(
      original.replace(/hash="[0-9a-f]+"/, ''),
    )
    expect(await run(['import', '/nonexistent.json'], c.io)).toBe(1)
  })

  it('init --backend sqlite creates a sqlite store the daemon-free CLI can use', async () => {
    const h = harness(repo())
    expect(await run(['init', 'Shop', '--backend', 'sqlite'], h.io)).toBe(0)
    const { storeDir } = resolveProject(h.io.cwd, h.io.env)
    expect(existsSync(join(storeDir, 'hafiz.sqlite'))).toBe(true)
    h.clear()
    expect(await run(['tree'], h.io)).toBe(0)
    expect(h.out).toHaveLength(1)
    expect(await run(['init', 'X', '--backend', 'oracle'], harness(repo()).io)).toBe(1)
  })
})

describe('hafiz install kilo', () => {
  it('adds the plugin to a new project config, idempotently, and removes it', async () => {
    const cwd = repo()
    const { io, out, clear } = harness(cwd)
    expect(await run(['install', 'kilo'], io)).toBe(0)
    const file = join(cwd, 'kilo.jsonc')
    const tui = join(cwd, 'tui.jsonc')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ plugin: ['@hafiz/kilo-plugin'] })
    // the TUI panel: same package, registered in Kilo's tui.json(c)
    expect(JSON.parse(readFileSync(tui, 'utf8'))).toEqual({ plugin: ['@hafiz/kilo-plugin'] })
    clear()
    expect(await run(['install', 'kilo', '--project'], io)).toBe(0)
    expect(out.join('\n')).toContain('already installed (server plugin)')
    expect(out.join('\n')).toContain('already installed (TUI panel)')
    expect(JSON.parse(readFileSync(file, 'utf8')).plugin).toEqual(['@hafiz/kilo-plugin'])
    expect(JSON.parse(readFileSync(tui, 'utf8')).plugin).toEqual(['@hafiz/kilo-plugin'])
    expect(await run(['uninstall', 'kilo'], io)).toBe(0)
    expect(JSON.parse(readFileSync(file, 'utf8')).plugin).toEqual([])
    expect(JSON.parse(readFileSync(tui, 'utf8')).plugin).toEqual([])
    clear()
    expect(await run(['uninstall', 'kilo'], io)).toBe(0)
    expect(out.join('\n')).toContain('not installed')
    expect(await run(['install', 'claude'], io)).toBe(1)
  })

  it('preserves comments and formatting in an existing .kilo/kilo.jsonc and keeps other plugins', async () => {
    const cwd = repo()
    const { io } = harness(cwd)
    mkdirSync(join(cwd, '.kilo'))
    const file = join(cwd, '.kilo/kilo.jsonc')
    const original = `{
  // my model
  "model": "anthropic/claude-sonnet-4", /* keep */
  "plugin": [
    "other-plugin", // trailing note
    ["tuned-plugin", { "a": 1 }]
  ],
  "mcp": {}
}
`
    writeFileSync(file, original)
    expect(await run(['install', 'kilo'], io)).toBe(0)
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('// my model')
    expect(after).toContain('/* keep */')
    expect(after).toContain('// trailing note')
    expect(after).toContain('"@hafiz/kilo-plugin"')
    expect(existsSync(join(cwd, 'kilo.jsonc'))).toBe(false)
    // the TUI entry goes next to the server config, keeping an existing tui.json's settings
    expect(JSON.parse(readFileSync(join(cwd, '.kilo/tui.jsonc'), 'utf8')).plugin).toEqual([
      '@hafiz/kilo-plugin',
    ])
    await run(['install', 'kilo'], io)
    expect(readFileSync(file, 'utf8')).toBe(after)
    expect(await run(['uninstall', 'kilo'], io)).toBe(0)
    const back = readFileSync(file, 'utf8')
    expect(back).not.toContain('hafiz')
    expect(back).toContain('"other-plugin"')
    expect(back).toContain('["tuned-plugin", { "a": 1 }]')
    expect(back).toContain('// trailing note')
  })

  it('--global edits ~/.config/kilo/kilo.jsonc, and doctor sees it', async () => {
    const cwd = repo()
    const { io, out, clear } = harness(cwd)
    await run(['init', 'Shop'], io)
    const tui = join(io.env.HOME as string, '.config/kilo/tui.json')
    mkdirSync(dirname(tui), { recursive: true })
    writeFileSync(tui, '{ "theme": "kilo", "plugin": ["x-tui"] }\n')
    expect(await run(['install', 'kilo', '--global'], io)).toBe(0)
    const file = join(io.env.HOME as string, '.config/kilo/kilo.jsonc')
    expect(JSON.parse(readFileSync(file, 'utf8')).plugin).toEqual(['@hafiz/kilo-plugin'])
    expect(existsSync(join(cwd, 'kilo.jsonc'))).toBe(false)
    expect(JSON.parse(readFileSync(tui, 'utf8'))).toEqual({
      theme: 'kilo',
      plugin: ['x-tui', '@hafiz/kilo-plugin'],
    })
    expect(existsSync(join(io.env.HOME as string, '.config/kilo/tui.jsonc'))).toBe(false)
    clear()
    await run(['doctor'], io)
    expect(out.join('\n')).toMatch(/ok\s+kilo\s+plugin listed in .*kilo\.jsonc/)
    expect(await run(['install', 'kilo', '--global', '--project'], io)).toBe(1)
    writeFileSync(file, '{ "plugin": ')
    expect(await run(['install', 'kilo', '--global'], io)).toBe(1)
  })
})
