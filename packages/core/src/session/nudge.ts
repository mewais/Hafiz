// Nudge (§7): in a project with no block tree, counter thresholds produce one line, once per
// session. Pure, so the daemon (tree-less project) and the plugin (no project at all, no daemon,
// in-memory counters) share the rule.
import type { Config } from '../config/schema.js'

export type NudgeConfig = Config['nudge']

/** The nudge line if a threshold is reached and the session's budget allows another. */
export function nudgeText(
  cfg: NudgeConfig,
  counters: Readonly<Record<string, number>>,
  alreadySent: number,
): string | undefined {
  if (alreadySent >= cfg.max_per_session) return undefined
  const over = Object.entries(cfg.thresholds).some(([k, t]) => (counters[k] ?? 0) >= t)
  if (!over) return undefined
  return cfg.template.replace(/\{(\w+)\}/g, (_, k: string) => String(counters[k] ?? 0))
}
