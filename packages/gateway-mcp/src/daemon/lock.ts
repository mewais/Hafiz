// Store lock: `<store>/.lock` holds the owning daemon's pid. A lock whose pid is dead is stale
// and is reclaimed, so a crashed daemon never wedges the project.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LockInfo {
  pid: number
  socket: string
  startedAt: string
}

export class DaemonLockedError extends Error {
  constructor(
    readonly pid: number,
    storeDir: string,
  ) {
    super(`store ${storeDir} is already served by a daemon (pid ${pid})`)
  }
}

export const lockPath = (storeDir: string) => join(storeDir, '.lock')

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readLock(storeDir: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(storeDir), 'utf8')) as Partial<LockInfo>
    return typeof info.pid === 'number'
      ? { pid: info.pid, socket: info.socket ?? '', startedAt: info.startedAt ?? '' }
      : null
  } catch {
    return null
  }
}

export interface Lock {
  release(): void
}

export function acquireLock(storeDir: string, socket: string): Lock {
  const file = lockPath(storeDir)
  const info: LockInfo = { pid: process.pid, socket, startedAt: new Date().toISOString() }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(info), { flag: 'wx' })
      return {
        release() {
          if (readLock(storeDir)?.pid === process.pid) {
            try {
              unlinkSync(file)
            } catch {}
          }
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const held = readLock(storeDir)
      if (held && pidAlive(held.pid)) throw new DaemonLockedError(held.pid, storeDir)
      try {
        unlinkSync(file) // stale (dead pid) or unreadable
      } catch {}
    }
  }
  throw new Error(`could not acquire ${file}`)
}
