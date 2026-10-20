// Pointer in git's common dir: worktrees share one project; per-session working trees for HEAD at
// done; the legacy `.hafiz/project.yaml` and `hafiz migrate-pointer`; brownfield detection.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadConfig, resolveProject } from '@hafiz/core'
import { DaemonClient, type DaemonHandle, hasExistingCode, startDaemon } from '@hafiz/gateway-mcp'
import { afterEach, describe, expect, it } from 'vitest'
import { type Io, run } from './commands.js'
import { withCore } from './shared.js'

const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

function repo(files: Record<string, string> = { 'README.md': 'x\n' }) {
  const dir = tmp('hafiz-repo-')
  git(dir, 'init', '-q')
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function harness(cwd: string) {
  const out: string[] = []
  const err: string[] = []
  const env = {
    ...process.env,
    HAFIZ_STORE_ROOT: tmp('hafiz-stores-'),
    HAFIZ_HOME: tmp('hafiz-home-'),
    XDG_RUNTIME_DIR: tmp('hafiz-rt-'),
  }
  const io: Io = { cwd, env, out: (l) => out.push(l), err: (l) => err.push(l) }
  return { io, out, err }
}

function commitIn(dir: string, file: string) {
  writeFileSync(join(dir, file), `${file}\n`)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', file)
  return git(dir, 'rev-parse', 'HEAD')
}

describe('pointer in the git common dir', () => {
  it('main checkout and two worktrees resolve to one project, store and pointer', async () => {
    const main = repo()
    const { io } = harness(main)
    expect(await run(['init', 'Shop'], io)).toBe(0)
    const pointerFile = join(main, '.git', 'hafiz', 'project.yaml')
    expect(existsSync(pointerFile)).toBe(true)
    expect(existsSync(join(main, '.hafiz'))).toBe(false)
    const wt1 = join(tmp('hafiz-wt-'), 'one')
    const wt2 = join(tmp('hafiz-wt-'), 'two')
    git(main, 'worktree', 'add', '-q', '-b', 'one', wt1)
    git(main, 'worktree', 'add', '-q', '-b', 'two', wt2)
    mkdirSync(join(wt2, 'src', 'deep'), { recursive: true })

    const m = resolveProject(main, io.env)
    for (const [cwd, top] of [
      [wt1, wt1],
      [join(wt2, 'src', 'deep'), wt2],
      [main, main],
    ]) {
      const p = resolveProject(cwd as string, io.env)
      expect(p.pointer.id).toBe(m.pointer.id)
      expect(p.storeDir).toBe(m.storeDir)
      expect(p.pointerFile).toBe(pointerFile)
      expect(p.legacy).toBe(false)
      expect(p.worktree).toBe(top) // git work happens in the caller's own tree
    }
    // `hafiz tree` from a worktree reads the shared store
    const w = harness(wt1)
    w.io.env = io.env
    expect(await run(['tree'], w.io)).toBe(0)
    expect(w.out.join('\n')).toMatch(/\[active\] shop-[0-9a-f]+ — Shop \(root\)/)
    // init from a worktree finds the existing project
    expect(await run(['init', 'Again'], w.io)).toBe(1)
    expect(w.err.join('\n')).toContain('already initialised')
  })

  it('one daemon serves every worktree; done records HEAD of the session’s own worktree', async () => {
    const main = repo()
    const { io } = harness(main)
    expect(await run(['init', 'Shop'], io)).toBe(0)
    const wt1 = join(tmp('hafiz-wt-'), 'one')
    const wt2 = join(tmp('hafiz-wt-'), 'two')
    git(main, 'worktree', 'add', '-q', '-b', 'one', wt1)
    git(main, 'worktree', 'add', '-q', '-b', 'two', wt2)
    const head1 = commitIn(wt1, 'one.ts')
    const head2 = commitIn(wt2, 'two.ts')
    const headMain = git(main, 'rev-parse', 'HEAD')
    expect(new Set([head1, head2, headMain]).size).toBe(3)

    // the daemon starts from the main checkout; the sessions say where they run
    const d: DaemonHandle = await startDaemon({ projectDir: main, env: io.env, idleShutdownMs: 0 })
    cleanup.push(() => d.close())
    const user = await DaemonClient.connect(d.socketPath)
    cleanup.push(() => user.close())
    await user.openSession({ id: 'cli', host: 'test', role: 'user' })
    const root = (await user.treeList())[0]?.id as string
    const block = async (title: string) => {
      const { result } = await user.dispatch<{ id: string }>('block.create', {
        parent: root,
        title,
      })
      await user.dispatch('block.set_status', { id: result.id, status: 'active' })
      return result.id
    }
    const digest = {
      outcome: 'Implemented in its worktree and committed there.',
      interface_delta: ['none'],
      pointers: [{ label: 'code', ref: 'src/x.ts' }],
    }
    const done = async (sid: string, cwd: string, id: string) => {
      const c = await DaemonClient.connect(d.socketPath)
      cleanup.push(() => c.close())
      await c.openSession({
        id: sid,
        host: 'test',
        role: 'worker',
        spawnedBlock: id,
        worktree: resolveProject(cwd, io.env).worktree,
      })
      await c.dispatch('block.request_done', { id, digest })
      return (await d.service.core.backend.read.getBlock(id))?.doneAt?.commit
    }
    const a = await block('A')
    const b = await block('B')
    expect(await done('w1', wt1, a)).toBe(head1)
    expect(await done('w2', join(wt2, '.'), b)).toBe(head2)
    expect((await d.service.core.backend.read.getSession('w1'))?.worktree).toBe(wt1)
    // a session that names no worktree falls back to the daemon's startup checkout
    const c = await block('C')
    await user.dispatch('block.set_status', {
      id: c,
      status: 'done',
      digest,
      confirmed: true,
    })
    expect((await d.service.core.backend.read.getBlock(c))?.doneAt?.commit).toBe(headMain)
  })

  it('refuses outside git', async () => {
    const dir = tmp('hafiz-nogit-')
    const { io, err } = harness(dir)
    expect(await run(['init', 'Shop'], io)).toBe(1)
    expect(err.join('\n')).toContain('not inside a git repository')
  })
})

describe('legacy .hafiz/project.yaml', () => {
  async function legacyRepo() {
    const main = repo()
    const h = harness(main)
    expect(await run(['init', 'Shop'], h.io)).toBe(0)
    // what an older `hafiz init` wrote
    mkdirSync(join(main, '.hafiz'))
    renameSync(join(main, '.git', 'hafiz', 'project.yaml'), join(main, '.hafiz', 'project.yaml'))
    return { main, ...h }
  }

  it('still resolves, doctor suggests migrate-pointer, init refuses', async () => {
    const { main, io, out, err } = await legacyRepo()
    mkdirSync(join(main, 'sub'))
    const p = resolveProject(join(main, 'sub'), io.env)
    expect(p.legacy).toBe(true)
    expect(p.pointerFile).toBe(join(main, '.hafiz', 'project.yaml'))
    expect(p.worktree).toBe(main)
    expect(await run(['tree'], io)).toBe(0)
    out.length = 0
    await run(['doctor'], io)
    expect(out.join('\n')).toMatch(/warn pointer +legacy pointer .*hafiz migrate-pointer/)
    expect(await run(['init', 'Shop'], io)).toBe(1)
    expect(err.join('\n')).toContain('hafiz migrate-pointer')
  })

  it('migrate-pointer moves it into the git dir and deletes the legacy file', async () => {
    const { main, io, out } = await legacyRepo()
    const before = resolveProject(main, io.env)
    const text = readFileSync(before.pointerFile, 'utf8')
    expect(await run(['migrate-pointer'], io)).toBe(0)
    expect(out.join('\n')).toContain('moved pointer')
    expect(existsSync(join(main, '.hafiz'))).toBe(false)
    const after = resolveProject(main, io.env)
    expect(after.legacy).toBe(false)
    expect(after.pointerFile).toBe(join(main, '.git', 'hafiz', 'project.yaml'))
    expect(readFileSync(after.pointerFile, 'utf8')).toBe(text)
    expect(after.pointer.id).toBe(before.pointer.id)
    // nothing left to migrate
    expect(await run(['migrate-pointer'], io)).toBe(1)
  })
})

describe('brownfield detection', () => {
  const code = Object.fromEntries(
    ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'package.json'].map((f) => [f, `// ${f}\n`]),
  )

  it('a repo with commits and enough source files starts with onboarding pending', async () => {
    const main = repo({ ...code, 'README.md': 'x\n' })
    const { io, out } = harness(main)
    expect(await run(['init', 'Legacy'], io)).toBe(0)
    expect(out.join('\n')).toContain('onboarding: pending')
    const project = await withCore(io, (core) => core.backend.read.getProject())
    expect(project?.onboarding).toBe('pending')
  })

  it('greenfield (no commits, or docs only) does not', async () => {
    const empty = tmp('hafiz-empty-')
    git(empty, 'init', '-q')
    const docs = repo({ 'README.md': 'x\n', LICENSE: 'MIT\n', '.gitignore': 'dist\n' })
    for (const dir of [empty, docs]) {
      const { io, out } = harness(dir)
      expect(await run(['init', 'Fresh'], io)).toBe(0)
      expect(out.join('\n')).not.toContain('onboarding')
    }
  })

  it('the threshold is config (onboarding.min_source_files)', () => {
    const main = repo(code)
    const config = loadConfig()
    expect(hasExistingCode(main, config)).toBe(true)
    config.hafiz.onboarding.min_source_files = 6
    expect(hasExistingCode(main, config)).toBe(false)
  })
})
