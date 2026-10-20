// The one place a storage backend is chosen: `hafiz.yaml storage.backend` (fs | sqlite).
import { join } from 'node:path'
import type { Config, StorageBackend } from '@hafiz/core'
import { FsBackend } from '@hafiz/storage-fs'
import { SqliteBackend } from '@hafiz/storage-sqlite'

export const SQLITE_FILE = 'hafiz.sqlite'

export const STORAGE_BACKENDS = ['fs', 'sqlite'] as const

export interface CreateBackendOptions {
  /** Seconds to batch minor writes before committing (fs); default from `hafiz.yaml`. */
  minorBatchSeconds?: number
}

export function createBackend(
  config: Config,
  storeDir: string,
  opts: CreateBackendOptions = {},
): StorageBackend {
  const kind = config.hafiz.storage.backend
  if (kind === 'sqlite') return new SqliteBackend({ file: join(storeDir, SQLITE_FILE) })
  if (kind === 'fs')
    return new FsBackend({
      dir: storeDir,
      git: config.hafiz.storage.git.enabled,
      minorBatchSeconds:
        opts.minorBatchSeconds ?? config.hafiz.storage.git.minor_write_batch_seconds,
    })
  throw new Error(`unknown storage backend '${kind}'. Known: ${STORAGE_BACKENDS.join(', ')}`)
}
