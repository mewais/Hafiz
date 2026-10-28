// Errors are part of the agent-facing protocol: messages state what happened and the remedy.

export type ErrorCode =
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'validation'
  | 'cap_exceeded'
  | 'guard_failed'
  | 'invalid_transition'
  | 'store'

export class HafizError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HafizError'
    this.code = code
    this.details = details
  }
  toJSON() {
    return { code: this.code, message: this.message, ...this.details }
  }
}

export class NotFoundError extends HafizError {
  constructor(entity: string, id: string) {
    super('not_found', `${entity} '${id}' not found`, { entity, id })
  }
}

/** Stale expected_version. Carries the current value so the caller can re-read and retry. */
export class ConflictError extends HafizError {
  constructor(target: string, expected: number, actual: number, current: unknown) {
    super(
      'conflict',
      `${target} changed since you read it (expected version ${expected}, now ${actual}). Re-read the returned current value and retry.`,
      { target, expected, actual, current },
    )
  }
}

export class ForbiddenError extends HafizError {
  constructor(role: string, command: string) {
    super(
      'forbidden',
      `role '${role}' may not call '${command}'. If this is needed, ask the manager or the user.`,
      { role, command },
    )
  }
}

export class ValidationError extends HafizError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('validation', message, details)
  }
}

export interface CapOverage {
  section: string
  measured: number
  cap: number
}

/** Every section beyond its cap's soft zone, so one rejection is enough to fix them all. */
export class CapExceededError extends HafizError {
  constructor(overages: CapOverage[], softZone: number, remedy: string) {
    const lines = overages.map(
      (o) =>
        `- '${o.section}': ${o.measured} tokens, cap ${o.cap}, ${o.measured - o.cap} over (+${Math.round(((o.measured - o.cap) / o.cap) * 100)}%)`,
    )
    super(
      'cap_exceeded',
      `${overages.length === 1 ? '1 section is' : `${overages.length} sections are`} over the cap (a write is accepted up to ${Math.round(softZone * 100)}% over, with a notice):\n${lines.join('\n')}\n${remedy}`,
      { sections: overages, remedy },
    )
  }
}

export class GuardError extends HafizError {
  constructor(guard: string, message: string, details: Record<string, unknown> = {}) {
    super('guard_failed', message, { guard, ...details })
  }
}

export class InvalidTransitionError extends HafizError {
  /**
   * `allowed`: where `from` may go (policies.yaml); `activatedBy`: roles whose spawn on a planned
   * block activates it (`status.activate_on_spawn`). Both only shape the remedy in the message.
   */
  constructor(
    from: string,
    to: string,
    allowed: readonly string[] = [],
    activatedBy: readonly string[] = [],
  ) {
    let remedy = allowed.length ? `; from '${from}' it can go to ${allowed.join(', ')}` : ''
    if (from === 'planned' && allowed.includes('active'))
      remedy = `: the block is planned, so its work has not started. ${
        activatedBy.length
          ? `A ${activatedBy.join(' or ')} spawned on it activates it; or set`
          : 'Set'
      } it active first, then ${to}`
    super('invalid_transition', `cannot move a block from '${from}' to '${to}'${remedy}`, {
      from,
      to,
      allowed,
    })
  }
}
