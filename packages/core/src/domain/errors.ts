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

export class CapExceededError extends HafizError {
  constructor(section: string, measured: number, cap: number, remedy: string) {
    super('cap_exceeded', `section '${section}' is ${measured} tokens; cap is ${cap}. ${remedy}`, {
      section,
      measured,
      cap,
      remedy,
    })
  }
}

export class GuardError extends HafizError {
  constructor(guard: string, message: string, details: Record<string, unknown> = {}) {
    super('guard_failed', message, { guard, ...details })
  }
}

export class InvalidTransitionError extends HafizError {
  constructor(from: string, to: string) {
    super('invalid_transition', `cannot move a block from '${from}' to '${to}'`, { from, to })
  }
}
