import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type Actor,
  type BlockDetail,
  Core,
  type DocType,
  loadConfig,
  type Notice,
  opaqueId,
} from '@hafiz/core'
import { docToMarkdown, FsBackend } from '@hafiz/storage-fs'
import { stringify } from 'yaml'
import {
  CliError,
  defaultStoreRoot,
  originFingerprint,
  osUser,
  POINTER_PATH,
  type Pointer,
  readPointer,
  repoRootOf,
  resolveProject,
} from './resolve.js'

export interface Io {
  cwd: string
  env: NodeJS.ProcessEnv
  out: (line: string) => void
  err: (line: string) => void
}

const DOC_TYPES: readonly DocType[] = ['design', 'plan', 'digest']

const USAGE = `usage: hafiz <command> [options]

  init <name> [--store-root DIR] [--adopt]   create a store for the current repo
  tree [--json]                              print the block tree
  show <block> [--zoom Z] [--json]           print a block
  history <block> [type] [--json]            git history of a block or one doc
  revert <block> <type> <commit>             restore a doc from an earlier commit
`

export function userActor(): Actor {
  return { sessionId: 'cli', role: 'user', agent: osUser() }
}

async function withCore<T>(io: Io, fn: (core: Core, storeDir: string) => Promise<T>): Promise<T> {
  const { storeDir } = resolveProject(io.cwd, io.env)
  return openAndRun(storeDir, fn)
}

async function openAndRun<T>(
  storeDir: string,
  fn: (core: Core, storeDir: string) => Promise<T>,
): Promise<T> {
  const backend = new FsBackend({ dir: storeDir, minorBatchSeconds: 0 })
  await backend.open()
  try {
    return await fn(new Core({ config: loadConfig(), backend }), storeDir)
  } finally {
    await backend.close()
  }
}

function printNotices(io: Io, notices: Notice[]) {
  for (const n of notices) io.err(`${n.level}: ${n.text}`)
}

function docType(s: string | undefined): DocType {
  if (!DOC_TYPES.includes(s as DocType))
    throw new CliError(`doc type must be one of ${DOC_TYPES.join(', ')}`)
  return s as DocType
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new CliError(`missing ${what}\n\n${USAGE}`)
  return v
}

// ───────────────────────────── init ─────────────────────────────

export async function init(
  io: Io,
  name: string,
  opts: { storeRoot?: string | undefined; adopt?: boolean | undefined },
): Promise<void> {
  const repoRoot = repoRootOf(io.cwd)
  const pointerFile = join(repoRoot, POINTER_PATH)
  if (existsSync(pointerFile)) {
    const existing = readPointer(pointerFile)
    if (existsSync(existing.store))
      throw new CliError(`already initialised (store ${existing.store})`)
    if (!opts.adopt)
      throw new CliError(
        `this repo points at a store that no longer exists (${existing.store}); ` +
          'run `hafiz init --adopt <name>` to create a fresh store and re-point the repo',
      )
  }
  const root = resolve(io.cwd, opts.storeRoot ?? defaultStoreRoot(io.env))
  const id = opaqueId('prj', 4)
  const storeDir = join(root, id)
  const fingerprint = originFingerprint(repoRoot)
  await openAndRun(storeDir, async (core) => {
    const { notices } = await core.projectInit(userActor(), {
      name,
      originFingerprint: fingerprint,
      id,
    })
    printNotices(io, notices)
  })
  const pointer: Pointer = { id, fingerprint, store: storeDir }
  mkdirSync(join(repoRoot, '.hafiz'), { recursive: true })
  writeFileSync(pointerFile, stringify(pointer))
  io.out(`initialised project ${id} (${name})`)
  io.out(`store:   ${storeDir}`)
  io.out(`pointer: ${pointerFile}`)
}

// ───────────────────────────── reads ─────────────────────────────

export async function tree(io: Io, opts: { json?: boolean | undefined }): Promise<void> {
  const rows = await withCore(io, (core) => core.treeList(userActor()))
  if (opts.json) return io.out(JSON.stringify(rows, null, 2))
  for (const b of rows)
    io.out(`${'  '.repeat(b.depth)}[${b.status}] ${b.id} — ${b.title} (${b.kind})`)
}

function renderBlock(d: BlockDetail): string[] {
  const b = d.block
  const lines = [
    `# ${b.title}`,
    `id: ${b.id}  kind: ${b.kind}  status: ${b.status}  version: ${b.version}`,
    `parent: ${b.parentId ?? '-'}  updated: ${b.updatedAt}`,
  ]
  if (d.edges.dependsOn.length)
    lines.push(`depends on: ${d.edges.dependsOn.map((e) => e.to).join(', ')}`)
  if (d.edges.dependents.length)
    lines.push(`dependents: ${d.edges.dependents.map((e) => e.from).join(', ')}`)
  for (const type of DOC_TYPES) {
    const doc = d.docs[type]
    if (doc) lines.push('', `## ${type} doc`, '', docToMarkdown(doc).trimEnd())
  }
  lines.push('', '## progress (last 10)')
  const prog = d.progress.slice(-10)
  if (!prog.length) lines.push('(none)')
  for (const p of prog) lines.push(`${p.ts} [${p.kind}] ${p.by.agent ?? p.by.role}: ${p.text}`)
  lines.push('', '## active decisions')
  const decisions = d.decisions.filter((x) => x.status === 'active')
  if (!decisions.length) lines.push('(none)')
  for (const x of decisions)
    lines.push(`- ${x.id} ${x.title}: ${x.decision}${x.standing ? ' [standing]' : ''}`)
  lines.push('', '## open threads')
  const threads = d.threads.filter((x) => x.status === 'open')
  if (!threads.length) lines.push('(none)')
  for (const t of threads) lines.push(`- ${t.id} ${t.title} (${t.entries.length} entries)`)
  return lines
}

export async function show(
  io: Io,
  block: string,
  opts: { zoom?: string | undefined; json?: boolean | undefined },
): Promise<void> {
  const detail = await withCore(io, (core) => core.blockDetail(userActor(), block))
  if (opts.json) return io.out(JSON.stringify(detail, null, 2))
  if (opts.zoom) io.err(`note: --zoom ${opts.zoom} ignored; the zoom renderer arrives in M2`)
  for (const l of renderBlock(detail)) io.out(l)
}

export async function history(
  io: Io,
  block: string,
  type: string | undefined,
  opts: { json?: boolean | undefined },
): Promise<void> {
  const entries = await withCore(io, (core) =>
    core.backend.read.history(block, type ? docType(type) : undefined),
  )
  if (opts.json) return io.out(JSON.stringify(entries, null, 2))
  for (const e of entries) io.out(`${e.commit} ${e.ts} ${e.author} ${e.message}`)
}

// ───────────────────────────── revert ─────────────────────────────

export async function revert(io: Io, block: string, type: string, commit: string): Promise<void> {
  const t = docType(type)
  await withCore(io, async (core) => {
    const old = await core.backend.read.docAt(block, t, commit)
    if (!old) throw new CliError(`no ${t} doc for ${block} at commit ${commit}`)
    const { result, notices } = await core.docWrite(userActor(), {
      block,
      type: t,
      sections: old.sections,
    })
    printNotices(io, notices)
    io.out(`reverted ${block} ${t} to ${commit} (now version ${result.version})`)
  })
}

// ───────────────────────────── dispatch ─────────────────────────────

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        zoom: { type: 'string' },
        adopt: { type: 'boolean' },
        'store-root': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    })
    const [cmd, a, b, c] = positionals
    if (values.help || !cmd) {
      io.out(USAGE.trimEnd())
      return cmd || values.help ? 0 : 1
    }
    switch (cmd) {
      case 'init':
        await init(io, need(a, '<name>'), { storeRoot: values['store-root'], adopt: values.adopt })
        break
      case 'tree':
        await tree(io, values)
        break
      case 'show':
        await show(io, need(a, '<block>'), values)
        break
      case 'history':
        await history(io, need(a, '<block>'), b, values)
        break
      case 'revert':
        await revert(io, need(a, '<block>'), need(b, '<type>'), need(c, '<commit>'))
        break
      default:
        throw new CliError(`unknown command '${cmd}'\n\n${USAGE}`)
    }
    return 0
  } catch (e) {
    io.err(`hafiz: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
