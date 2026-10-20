// Where a project's daemon lives: a per-user runtime dir (0700) holding one socket per project.
import { chmodSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, 'hafiz')
  return join(tmpdir(), `hafiz-${process.getuid?.() ?? 0}`)
}

export function socketPathFor(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(runtimeDir(env), `${projectId}.sock`)
}

/** Create the runtime dir (mode 0700, enforced even if it pre-existed). */
export function ensureRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = runtimeDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}
