import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { type Actor, Core, type DocType, loadConfig, type Notice, opaqueId } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
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
  show <block> [--zoom Z] [--json]           print a block at a zoom level (default FULL)
  context --role R [--focus a,b] [--budget N] [--explain id]
                                             print the view an agent in role R would get
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

export async function show(
  io: Io,
  block: string,
  opts: { zoom?: string | undefined; json?: boolean | undefined },
): Promise<void> {
  await withCore(io, async (core) => {
    if (opts.json)
      return io.out(JSON.stringify(await core.blockDetail(userActor(), block), null, 2))
    io.out(await core.blockRead(userActor(), block, opts.zoom ?? 'FULL'))
  })
}

export async function context(
  io: Io,
  opts: {
    role?: string | undefined
    focus?: string | undefined
    budget?: string | undefined
    explain?: string | undefined
  },
): Promise<void> {
  const role = need(opts.role, '--role')
  const budgetTokens = opts.budget !== undefined ? Number(opts.budget) : undefined
  if (budgetTokens !== undefined && !(budgetTokens > 0))
    throw new CliError('--budget must be a positive number of tokens')
  const focus = opts.focus
    ? {
        blocks: opts.focus
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        computed: false,
      }
    : undefined
  // An ad-hoc session: rendered for the role, never persisted.
  const ctx = {
    adhoc: { role, ...(focus ? { focus } : {}) },
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  }
  await withCore(io, async (core) => {
    if (opts.explain) {
      io.out((await core.contextExplain(userActor(), opts.explain, ctx)).text)
      return
    }
    const v = await core.contextFor(userActor(), ctx)
    io.out(v.text)
    if (v.floorText) io.out(`\n${v.floorText}`)
    io.err(`${v.tokens}/${v.budget} tokens · ${v.manifest.length} blocks · hash ${v.hash}`)
  })
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
        role: { type: 'string' },
        focus: { type: 'string' },
        budget: { type: 'string' },
        explain: { type: 'string' },
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
      case 'context':
        await context(io, values)
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
