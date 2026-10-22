import type { Config } from '../config/schema.js'
import { ForbiddenError, HafizError } from '../domain/errors.js'
import { mayApprove } from '../domain/review.js'
import type { Proposal } from '../domain/types.js'

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

/**
 * Resolving a proposal (`proposal.accept` / `proposal.reject`): the allowlist, and for design
 * and plan reviews also `policies.yaml review.approver` (the user always may).
 */
export function authorizeResolve(
  config: Config,
  role: string,
  command: string,
  p: Pick<Proposal, 'source'>,
): void {
  authorize(config, role, command)
  if (p.source !== 'review' || mayApprove(config.policies.review, role)) return
  throw new HafizError(
    'forbidden',
    `role '${role}' may not resolve design or plan reviews: the approver is ${config.policies.review.approver} (policies.yaml review.approver). The user runs: hafiz review`,
    { role, command },
  )
}
