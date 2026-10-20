export interface Clock {
  now(): string
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

/** Deterministic clock for tests and golden files. */
export function fixedClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1000): Clock {
  let t = Date.parse(start)
  return {
    now() {
      const s = new Date(t).toISOString()
      t += stepMs
      return s
    },
  }
}
