// Counter deltas the Kilo adapter feeds Core (§7), shared by the full plugin and the no-tree
// nudge path so both count the same things.

/** Kilo tools that write files. */
export const WRITE_TOOLS = new Set(['edit', 'write', 'patch', 'apply_patch', 'multiedit'])

/** Counters for one finished tool call. */
export function toolCounters(tool: string): Record<string, number> {
  return {
    tool_calls: 1,
    ...(WRITE_TOOLS.has(tool) ? { files_written: 1 } : {}),
    ...(tool === 'task' ? { subagents_spawned: 1 } : {}),
  }
}

/** Counters for one user message. `turns` counts exchanges, `user_turns` the user's side. */
export const USER_TURN_COUNTERS: Record<string, number> = { turns: 1, user_turns: 1 }
