import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type Actor,
  type DocType,
  describeProposal,
  focusFromPolicy,
  isViewerSession,
  opaqueId,
  renderCostTable,
} from '@hafiz/core'
import { type DaemonClient, ensureDaemon, runMcpStdio, startDaemon } from '@hafiz/gateway-mcp'
import { stringify } from 'yaml'
import { doctor } from './doctor.js'
import { installHost } from './install-host.js'
import { migrate } from './migrate.js'
import { exportCmd, importCmd } from './portable.js'
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
import {
  type Io,
  openAndRun,
  printNotices,
  userActor,
  withCore,
  writeStoreBackend,
} from './shared.js'

export { type Io, userActor } from './shared.js'

const DOC_TYPES: readonly DocType[] = ['design', 'plan', 'digest']

const USAGE = `usage: hafiz <command> [options]

  init <name> [--store-root DIR] [--adopt] [--backend fs|sqlite]
                                             create a store for the current repo
  tree [--json]                              print the block tree
  show <block> [--zoom Z] [--json]           print a block at a zoom level (default FULL)
  context --role R [--focus a,b] [--budget N] [--explain id]
                                             print the view an agent in role R would get
  history <block> [type] [--json]            git history of a block or one doc
  revert <block> <type> <commit>             restore a doc from an earlier commit
  status [--json]                            project, epoch, sessions, cost, pending proposals
  checkpoint [--session ID]                  condense live sessions' conversation tails now
  review [--accept ID | --reject ID]         list or resolve the proposal queue
  direct "<text>" [--block ID] [--kind K]    record a standing decision (K: never|always|prefer)
  focus [--role R]                           live sessions' focus (or the focus a role would get)
  explain <block> [--role R] [--session ID]  why a block shows at its zoom
  migrate [--dry-run]                        upgrade docs to the schema set's version
  doctor [--online] [--json]                 check wiring, store health, schema failures, drift
  export <file>                              write a portable JSON snapshot of the store
  import <file> [--as-new] [--backend B]    load a snapshot into an empty store
  install kilo [--global|--project]          add the Hafiz plugin to Kilo's config
  uninstall kilo [--global|--project]        remove it again
  daemon [--project DIR]                     run the project daemon in the foreground
  mcp --role R [--project DIR]               serve MCP on stdio for role R
`

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
  opts: {
    storeRoot?: string | undefined
    adopt?: boolean | undefined
    backend?: string | undefined
  },
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
  // The store's own config layer selects the backend (hafiz.yaml storage.backend).
  if (opts.backend) writeStoreBackend(storeDir, opts.backend)
  await openAndRun(storeDir, io.env, async (core) => {
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

// ───────────────────────────── daemon-backed writes ─────────────────────────────

/** Writes go through the project's daemon (started on demand) so there is a single writer. */
async function withDaemon<T>(io: Io, fn: (c: DaemonClient) => Promise<T>): Promise<T> {
  const project = resolveProject(io.cwd, io.env)
  const client = io.connect
    ? await io.connect(project)
    : await ensureDaemon(project, {
        env: io.env,
        ...(io.entry ? { entry: io.entry } : {}),
      })
  try {
    await client.openSession({ id: 'cli', host: 'cli', role: 'user', agent: osUser() })
    return await fn(client)
  } finally {
    client.close()
  }
}

export async function direct(
  io: Io,
  text: string,
  opts: { block?: string | undefined; kind?: string | undefined },
): Promise<void> {
  const standing = opts.kind ?? 'always'
  if (!['never', 'always', 'prefer'].includes(standing))
    throw new CliError('--kind must be never, always or prefer')
  await withDaemon(io, async (c) => {
    const block = opts.block ?? (await c.treeList())[0]?.id
    if (!block) throw new CliError('the project has no blocks')
    const title = text.length > 60 ? `${text.slice(0, 57)}...` : text
    const { result, notices } = await c.dispatch<{ id: string }>('decision.record', {
      block,
      title,
      decision: text,
      standing,
    })
    printNotices(io, notices)
    io.out(`recorded standing decision ${result.id} (${standing}) on ${block}`)
  })
}

export async function review(
  io: Io,
  opts: { accept?: string | undefined; reject?: string | undefined },
): Promise<void> {
  if (opts.accept && opts.reject) throw new CliError('use either --accept or --reject')
  const id = opts.accept ?? opts.reject
  if (id) {
    await withDaemon(io, async (c) => {
      const { notices } = await c.dispatch(opts.accept ? 'proposal.accept' : 'proposal.reject', {
        id,
      })
      printNotices(io, notices)
      io.out(`${opts.accept ? 'accepted' : 'rejected'} ${id}`)
    })
    return
  }
  const pending = await withCore(io, (core) =>
    core.backend.read.listProposals({ status: 'pending' }),
  )
  if (!pending.length) return io.out('no pending proposals')
  for (const p of pending) for (const line of describeProposal(p)) io.out(line)
}

export async function checkpoint(io: Io, opts: { session?: string | undefined }): Promise<void> {
  await withDaemon(io, async (c) => {
    const r = await c.call<{ requested: string[] }>('checkpoint.request', {
      session: opts.session ?? '*',
    })
    io.out(
      r.requested.length
        ? `checkpoint requested for ${r.requested.join(', ')}: they condense at their next request`
        : 'no live session to checkpoint',
    )
  })
}

// ───────────────────────────── status / focus / explain ─────────────────────────────

export async function status(io: Io, opts: { json?: boolean | undefined }): Promise<void> {
  const data = await withCore(io, async (core) => {
    const r = core.backend.read
    const project = await r.getProject()
    const sessions = (await r.listSessions()).filter((s) => !isViewerSession(core.config.roles, s))
    const pending = await r.listProposals({ status: 'pending' })
    return { project, sessions, pending }
  })
  const sessions = data.sessions.map(({ token: _t, ...s }) => s)
  if (opts.json)
    return io.out(
      JSON.stringify(
        { project: data.project, sessions, pendingProposals: data.pending.length },
        null,
        2,
      ),
    )
  const p = data.project
  io.out(`project ${p?.id} (${p?.name}) epoch ${p?.epoch}`)
  const live = sessions.filter((s) => !s.endedAt)
  io.out(`sessions: ${live.length} active, ${sessions.length - live.length} ended`)
  for (const s of sessions) {
    const counters = Object.entries(s.counters)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    io.out(
      `  ${s.endedAt ? 'x' : '*'} ${s.role.padEnd(8)} ${s.id}${s.agent ? ` (${s.agent})` : ''}  focus: ${s.focus.blocks.join(', ') || '-'}${s.focus.computed ? ' (computed)' : ''}${counters ? `  ${counters}` : ''}`,
    )
  }
  if (sessions.some((s) => Object.keys(s.counters).length)) {
    io.out('cost:')
    for (const line of renderCostTable(sessions)) io.out(`  ${line}`)
  }
  io.out(`proposals: ${data.pending.length} pending`)
}

export async function focus(io: Io, opts: { role?: string | undefined }): Promise<void> {
  await withCore(io, async (core) => {
    if (opts.role) {
      const def = core.config.roles.roles[opts.role]
      if (!def) throw new CliError(`unknown role '${opts.role}'`)
      const f = focusFromPolicy(await core.backend.read.listBlocks(), def.focus_policy)
      return io.out(`${opts.role} (${def.focus_policy}): ${f.blocks.join(', ') || '-'}`)
    }
    const live = (await core.backend.read.listSessions({ active: true })).filter(
      (s) => !isViewerSession(core.config.roles, s),
    )
    if (!live.length) return io.out('no active sessions')
    for (const s of live)
      io.out(
        `${s.role.padEnd(8)} ${s.id}: ${s.focus.blocks.join(', ') || '-'}${s.focus.computed ? ' (computed)' : ' (explicit)'}`,
      )
  })
}

export async function explain(
  io: Io,
  block: string,
  opts: { role?: string | undefined; session?: string | undefined },
): Promise<void> {
  await withCore(io, async (core) => {
    if (opts.session) {
      const by: Actor = { ...userActor(), sessionId: opts.session }
      return io.out((await core.contextExplain(by, block)).text)
    }
    const role = opts.role ?? 'manager'
    io.out((await core.contextExplain(userActor(), block, { adhoc: { role } })).text)
  })
}

// ───────────────────────────── daemon / mcp ─────────────────────────────

export async function daemon(io: Io, opts: { project?: string | undefined }): Promise<void> {
  const d = await startDaemon({ projectDir: resolve(io.cwd, opts.project ?? '.'), env: io.env })
  const stop = () => void d.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  io.err(`hafiz daemon for ${d.projectId} listening on ${d.socketPath}`)
  await d.closed
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}

export async function mcp(
  io: Io,
  opts: { role?: string | undefined; project?: string | undefined },
): Promise<void> {
  await runMcpStdio({
    role: need(opts.role, '--role'),
    projectDir: opts.project ? resolve(io.cwd, opts.project) : undefined,
    cwd: io.cwd,
    env: io.env,
    daemon: io.entry ? { entry: io.entry } : {},
  })
}

// ───────────────────────────── dispatch ─────────────────────────────

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    // `--project` is a DIR option elsewhere; for install/uninstall it is a bare scope flag.
    const hostCmd = argv[0] === 'install' || argv[0] === 'uninstall'
    const args = hostCmd ? argv.filter((x) => x !== '--project') : argv
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        zoom: { type: 'string' },
        role: { type: 'string' },
        focus: { type: 'string' },
        budget: { type: 'string' },
        explain: { type: 'string' },
        adopt: { type: 'boolean' },
        accept: { type: 'string' },
        reject: { type: 'string' },
        block: { type: 'string' },
        kind: { type: 'string' },
        project: { type: 'string' },
        session: { type: 'string' },
        backend: { type: 'string' },
        'dry-run': { type: 'boolean' },
        online: { type: 'boolean' },
        'as-new': { type: 'boolean' },
        global: { type: 'boolean' },
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
        await init(io, need(a, '<name>'), {
          storeRoot: values['store-root'],
          adopt: values.adopt,
          backend: values.backend,
        })
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
      case 'status':
        await status(io, values)
        break
      case 'review':
        await review(io, values)
        break
      case 'direct':
        await direct(io, need(a, '<text>'), values)
        break
      case 'checkpoint':
        await checkpoint(io, values)
        break
      case 'focus':
        await focus(io, values)
        break
      case 'explain':
        await explain(io, need(a, '<block>'), values)
        break
      case 'migrate':
        await migrate(io, { dryRun: values['dry-run'] })
        break
      case 'doctor':
        return await doctor(io, { online: values.online, json: values.json })
      case 'export':
        await exportCmd(io, need(a, '<file>'))
        break
      case 'import':
        await importCmd(io, need(a, '<file>'), {
          asNew: values['as-new'],
          backend: values.backend,
        })
        break
      case 'install':
      case 'uninstall':
        if (values.global && args.length !== argv.length)
          throw new CliError('use either --global or --project')
        await installHost(io, cmd, need(a, '<host>'), { global: !!values.global })
        break
      case 'daemon':
        await daemon(io, values)
        break
      case 'mcp':
        await mcp(io, values)
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
