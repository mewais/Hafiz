import type { Config } from '../config/schema.js'
import { ForbiddenError } from '../domain/errors.js'

/**
 * Allowlist patterns (roles.yaml `tools`):
 *   `block.create`        exact command, any qualifier
 *   `doc.write:design`    exact command with qualifier
 *   `block.*`             any command in the namespace
 *   `*`                   everything (the human CLI user)
 */
export function isAllowed(
  patterns: readonly string[],
  command: string,
  qualifier?: string,
): boolean {
  for (const p of patterns) {
    if (p === '*') return true
    if (p.endsWith('.*')) {
      if (command.startsWith(p.slice(0, -1))) return true
      continue
    }
    const [pc, pq] = p.split(':') as [string, string | undefined]
    if (pc !== command) continue
    if (pq === undefined || pq === qualifier) return true
  }
  return false
}

export function authorize(config: Config, role: string, command: string, qualifier?: string): void {
  const def = config.roles.roles[role]
  const patterns = def?.tools ?? []
  if (!isAllowed(patterns, command, qualifier))
    throw new ForbiddenError(role, qualifier ? `${command}:${qualifier}` : command)
}
