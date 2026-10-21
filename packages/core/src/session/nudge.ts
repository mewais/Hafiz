// Nudge (§7): in an untracked repo (no pointer), counter thresholds produce one line, once per
// session, suggesting hafiz_track_project. A tracked project never gets it, whatever its tree size.
// Pure; only the plugin's in-memory path (no project, no daemon) evaluates it.
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
