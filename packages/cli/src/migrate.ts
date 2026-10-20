// `hafiz migrate [--dry-run]`: upgrade stored docs to the schema set's version (ARCHITECTURE §4).
import { planMigration, resolveProject } from '@hafiz/core'
import { pidAlive, readLock } from '@hafiz/gateway-mcp'
import { CliError } from './resolve.js'
import { type Io, printNotices, userActor, withCore } from './shared.js'

/** A live daemon holds the store in memory; writing behind its back would be overwritten. */
export function assertNoDaemon(io: Io) {
  const { storeDir } = resolveProject(io.cwd, io.env)
  const lock = readLock(storeDir)
  if (lock && pidAlive(lock.pid))
    throw new CliError(
      `a daemon (pid ${lock.pid}) is serving this store; stop it first (it also exits when idle)`,
    )
}

export async function migrate(io: Io, opts: { dryRun?: boolean | undefined }): Promise<void> {
  if (!opts.dryRun) assertNoDaemon(io)
  await withCore(io, async (core) => {
    const project = await core.backend.read.getProject()
    if (!project) throw new CliError('the store has no project')
    const { blocks, docs } = await core.allDocs()
    const plan = planMigration(core.config, core.tok, project, blocks, docs)
    if (plan.error) throw new CliError(plan.error)
    if (plan.from === plan.to)
      return io.out(`schema set is at version ${plan.to}; nothing to migrate`)
    io.out(`schema set ${plan.from} → ${plan.to} (${plan.files.join(', ')})`)
    for (const c of plan.changes) io.out(`  ${c.block} ${c.type}: ${c.actions.join(', ')}`)
    io.out(`${plan.changes.length} doc(s) to rewrite`)
    if (plan.failures.length) {
      for (const f of plan.failures) io.err(`  cannot migrate ${f.block} ${f.type}: ${f.error}`)
      throw new CliError(
        `${plan.failures.length} doc(s) would not satisfy the new schema; fix the migration or the docs`,
      )
    }
    if (opts.dryRun) return io.out('dry run: nothing written')
    const { result, notices } = await core.schemaMigrate(userActor(), {
      to: plan.to,
      docs: plan.changes.map((c) => ({ block: c.block, type: c.type, sections: c.after })),
    })
    printNotices(io, notices)
    io.out(`migrated ${result.migrated} doc(s); project now pins schema set version ${plan.to}`)
  })
}
