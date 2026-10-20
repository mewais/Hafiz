// `hafiz export <file>` / `hafiz import <file> [--as-new]`: portable JSON snapshot of a store.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  defaultStoreRoot,
  exportStore,
  findPointerFile,
  gitPointerFile,
  importStore,
  opaqueId,
  originFingerprint,
  parseSnapshot,
  readPointer,
  repoRootOf,
  systemClock,
} from '@hafiz/core'
import { stringify } from 'yaml'
import type { Pointer } from './resolve.js'
import { type Io, openAndRun, userActor, withCore, writeStoreBackend } from './shared.js'

export async function exportCmd(io: Io, file: string): Promise<void> {
  const snap = await withCore(io, (core) => exportStore(core.backend, systemClock.now()))
  const target = resolve(io.cwd, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(snap, null, 2)}\n`)
  io.out(
    `exported ${snap.blocks.length} blocks, ${snap.docs.length} docs, ${snap.records.length} records to ${target}`,
  )
}

export async function importCmd(
  io: Io,
  file: string,
  opts: { asNew?: boolean | undefined; backend?: string | undefined },
): Promise<void> {
  const snap = parseSnapshot(readFileSync(resolve(io.cwd, file), 'utf8'))
  const worktree = repoRootOf(io.cwd) // refuses outside git
  const pointerFile = gitPointerFile(io.cwd)
  const found = findPointerFile(io.cwd)
  const existing = found ? readPointer(found) : null

  // The repo already points at a store: import into it (it must be empty) under the pointer's
  // identity. Otherwise create a store, keeping the snapshot's identity or minting a new one.
  if (existing && existsSync(existing.store)) {
    const project = await openAndRun(existing.store, io.env, (core) =>
      importStore(core.backend, snap, userActor(), {
        asNew: { id: existing.id, fingerprint: existing.fingerprint },
      }),
    )
    return io.out(`imported project ${project.name} into ${existing.store}`)
  }
  const fresh = opts.asNew
    ? { id: opaqueId('prj', 4), fingerprint: originFingerprint(worktree) }
    : null
  const id = fresh?.id ?? snap.project.id
  const storeDir = join(resolve(io.cwd, defaultStoreRoot(io.env)), id)
  if (opts.backend) writeStoreBackend(storeDir, opts.backend)
  const project = await openAndRun(storeDir, io.env, (core) =>
    importStore(core.backend, snap, userActor(), fresh ? { asNew: fresh } : {}),
  )
  const pointer: Pointer = { id, fingerprint: project.originFingerprint, store: storeDir }
  mkdirSync(dirname(pointerFile), { recursive: true })
  writeFileSync(pointerFile, stringify(pointer))
  io.out(`imported project ${id} (${project.name}) into ${storeDir}`)
}
