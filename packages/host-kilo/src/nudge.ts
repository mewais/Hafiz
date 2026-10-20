// The cheap path for repos without a Hafiz project (§7 Nudge). Nothing here touches the daemon
// or the disk: counters live in plugin memory, and when a threshold in nudge.yaml trips the one
// line is added to the session's next system prompt through Kilo's system.transform hook, once.
// (Hosts without that hook simply never show it; the nudge is a courtesy, not a protocol.)
import { type Config, nudgeText } from '@hafiz/core'
import { toolCounters, USER_TURN_COUNTERS } from './counters.js'
import type { Hooks, KiloEvent } from './kilo.js'

export function createNudgeHooks(config: Config): Hooks {
  const cfg = config.nudge
  if (cfg.max_per_session <= 0) return {}
  const counters = new Map<string, Record<string, number>>()
  const sent = new Map<string, number>()
  const pending = new Map<string, string>()

  const bump = (sid: string, delta: Record<string, number>) => {
    const c = counters.get(sid) ?? {}
    for (const [k, v] of Object.entries(delta)) c[k] = (c[k] ?? 0) + v
    counters.set(sid, c)
    const n = sent.get(sid) ?? 0
    const text = pending.has(sid) ? undefined : nudgeText(cfg, c, n)
    if (text) {
      sent.set(sid, n + 1)
      pending.set(sid, text)
    }
  }

  return {
    async 'chat.message'(i) {
      bump(i.sessionID, USER_TURN_COUNTERS)
    },
    async 'tool.execute.after'(i) {
      bump(i.sessionID, toolCounters(i.tool))
    },
    async 'experimental.chat.system.transform'(i, o) {
      const line = i.sessionID ? pending.get(i.sessionID) : undefined
      if (!line || !i.sessionID) return
      pending.delete(i.sessionID)
      o.system.push(line)
    },
    async event({ event }: { event: KiloEvent }) {
      if (event.type !== 'session.deleted') return
      const id = (event.properties?.sessionID ?? (event.properties?.info as { id?: string })?.id) as
        | string
        | undefined
      if (id) {
        counters.delete(id)
        sent.delete(id)
        pending.delete(id)
      }
    },
  }
}
