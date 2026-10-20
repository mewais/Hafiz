# Hafiz — Host Capability Matrix and Adapter Designs

What each host actually exposes (verified against current documentation and, where noted, source,
on 2026-10-20), and how the Hafiz adapter for each host is built on top of it. Companion to
[`ARCHITECTURE.md`](ARCHITECTURE.md) §12.

Legend: ✅ documented · ⚠️ documented with caveat · 🧪 present but experimental/unverified · ❌ absent.

> Kilo note: everything here is about the **current** Kilo (OpenCode-based CLI 1.0 and the rebuilt
> VS Code extension). The legacy Cline/Roo-derived extension (`.kilocodemodes`, `mcp_settings.json`,
> memory bank, Orchestrator mode) is archived and not targeted.

---

## 1. Capability matrix

| Capability | Claude Code | Codex | Kilo (current) |
|---|---|---|---|
| **Packaging** | ✅ plugin: `plugin.json`, hooks + MCP + skills + agents + commands | ✅ plugin: `plugin.json`, skills + MCP + hooks (no AGENTS.md payload) | ✅ TS plugin module (`@kilocode/plugin`); `config` hook can add agents/commands/instructions/MCP |
| **Hook: user prompt** | ✅ `UserPromptSubmit` → `additionalContext` | ✅ `UserPromptSubmit` → `additionalContext` | ✅ `chat.message` (inspect/modify parts) |
| **Hook: session start / after compaction** | ✅ `SessionStart` matcher `compact` re-injects | ✅ `SessionStart` matcher `compact` (runs before next model request, incl. mid-turn) | ✅ `session.created` / `session.compacted` events |
| **Hook: before/after tool** | ✅ `PreToolUse` (`updatedInput`, deny), `PostToolUse` (`updatedToolOutput` for **any** tool) | ✅ `PreToolUse` (`updatedInput`, deny), `PostToolUse` (`decision: block` replaces result with feedback; `additionalContext`) | ✅ `tool.execute.before` (mutate args / throw), `tool.execute.after` (rewrite output) |
| **Hook: subagent start/stop** | ✅ `SubagentStart/Stop` (+ `agent_transcript_path`) | ✅ `SubagentStart/Stop` (matcher on agent type) | ⚠️ via `session.*` events on child sessions |
| **Rewrite full message history before send** | ❌ | ❌ (`Pre/PostModelRequest` observe-only, unreleased) | 🧪 `experimental.chat.messages.transform` |
| **Modify system prompt per request** | ❌ | ❌ | 🧪 `experimental.chat.system.transform` |
| **Steer compaction prompt** | ⚠️ only static CLAUDE.md "Compact Instructions"; `PreCompact` can veto only | ✅ `compact_prompt` / `experimental_compact_prompt_file` in config.toml; `PreCompact` veto only | 🧪 `experimental.session.compacting` (append context or replace prompt) |
| **Trigger compaction programmatically** | ❌ | ⚠️ only via app-server `thread/compact/start` | ⚠️ not documented (SDK client, inferred) |
| **Compaction thresholds** | ✅ user/env settings (`autoCompactWindow`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`); not settable by a plugin | ✅ `model_auto_compact_token_limit` (+ scope) | ✅ `compaction.{threshold_percent, prune, tail_turns, preserve_recent_tokens, reserved}` |
| **Built-in tool-result pruning** | ✅ clears older tool outputs before summarizing (not configurable) | ⚠️ `tools.<t>.output_token_limit` per MCP tool | ✅ `compaction.prune` (clears completed tool outputs outside a 40K recency window) |
| **Delete/rewrite earlier turns** | ❌ | ❌ | 🧪 only via messages.transform |
| **MCP: stdio / HTTP** | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| **MCP: elicitation** | ✅ (form + URL) | ✅ (form + URL) | ❌ (commented out in source) |
| **MCP: resources / prompts** | ✅ / ✅ | ✅ / ❌ | ✅ / ✅ (prompts in source only) |
| **MCP: client cwd** | ✅ `CLAUDE_PROJECT_DIR` env + `roots/list` | ⚠️ `cwd` per server config; roots not confirmed | ✅ roots → cwd |
| **Per-agent tool restriction** | ✅ `tools:`/`disallowedTools:` in agent frontmatter; server-level `mcp__srv__*` documented, **per-tool untested** | ⚠️ custom agents **cannot** change `mcp_servers`; per-server `enabled_tools` is global; profiles (`--profile`) only for top-level processes | ✅ per-agent `permission` map with `{server}_{tool}` globs; MCP denials inherited as hard ceilings |
| **Subagent result to parent** | ✅ Agent tool result (final report) | ✅ "summaries rather than raw output" | ✅ child's final text, untruncated, in `<task_result>` |
| **Subagent sees parent history** | ❌ (unless `fork`) | ❌ | ❌ (unless `task_id` resume) |
| **Permission allow-all for a server** | ✅ `permissions.allow: ["mcp__srv__*"]` (user/project settings; **not** settable by the plugin) | ✅ `mcp_servers.srv.default_tools_approval_mode = "auto"` | ✅ `permission: {"srv_*": "allow"}` |
| **Deny file access to a path outside project** | ✅ `Read(~/.hafiz/**)`, `Edit(~/.hafiz/**)`; Bash needs its own rule | ✅ sandbox: home not writable under `workspace-write` | ✅ `permission.edit/read` globs (last match wins) |
| **Custom base URL** | ✅ `ANTHROPIC_BASE_URL`; must forward `anthropic-*` headers, `cache_control`, SSE pings; OAuth login works if beta header forwarded | ✅ `model_providers.<id>` with `requires_openai_auth` for ChatGPT login; **Responses wire only** | ✅ `provider.<id>.options.baseURL`; UI offers OpenAI-compat / Responses / Anthropic |
| **Wire format** | Anthropic Messages | OpenAI Responses | depends on provider |
| **Prompt-cache layout** | ✅ documented: system+tools → project context → conversation; hook context appends (safe); tool-list changes invalidate | not documented | not documented (`setCacheKey` option exists) |
| **Nudge visibility (counters)** | ✅ hooks | ✅ hooks | ✅ events |

### Items to verify by experiment before relying on them

1. Claude Code: individual MCP tool names in agent `tools:` (`mcp__plugin_hafiz_worker__read_block`).
2. Claude Code: `PostToolUse.updatedToolOutput` applied to the `Agent` tool (subagent reports).
3. Codex: whether `PreToolUse` input carries `agent_type` (would allow hook-enforced per-role denies).
4. Kilo: stability of the `experimental.*` hooks across releases; whether `agent.compaction.prompt` works.
5. Codex: `requires_openai_auth` provider entry in user `config.toml` (documented for managed
   `requirements.toml`; source suggests it works generally).

---

## 2. Cross-host conclusions (these shape the adapters)

**C1. Role = MCP server instance.** Per-tool allowlisting is uneven (documented in Kilo, untested in
Claude Code, impossible per-subagent in Codex). Server-level allowlisting is universal. So Hafiz
ships one logical server per role — `hafiz mcp --role worker` exposes only the worker's tools — and
adapters register the role servers they need. Per-tool globs become a bonus, not a requirement.
Codex caveat: all subagents in one Codex session share the parent's MCP servers, so within a single
Codex process role separation is **advisory** (the server still checks the declared role; the host
cannot hide tools per subagent). Hard separation on Codex exists only across processes (`--profile`).

**C2. Injection is append-only on Claude Code and Codex, prefix-stable on Kilo.** Claude Code and
Codex can only *add* context (`additionalContext`); they cannot replace earlier text. Kilo can place
the envelope in the system prompt and rewrite history. Therefore:
- Kilo: envelope in the system prompt via `chat.system.transform`; replaced in place on epoch change.
- Claude Code / Codex: envelope injected at `SessionStart` (all sources, including `compact`); on
  epoch change a **fresh envelope is appended** via `UserPromptSubmit` (`additionalContext`) carrying
  the new epoch. Rules: *the envelope with the highest epoch is authoritative; earlier ones are
  stale.* Stale copies cost tokens until the next compaction, which is acceptable because epochs
  are rare by design and `SessionStart(compact)` restores a single fresh copy.

**C3. Re-inject after compaction is the keystone on Claude Code and Codex.** Both run
`SessionStart` with `source=compact` before the next model request. The adapter answers it with
`context.for(session)`. This makes host compaction harmless to the view: whatever the summarizer
keeps or drops, the structured context comes back intact. Hafiz-driven compaction prompts are a
bonus where available (Codex `compact_prompt`, Kilo `session.compacting`); Claude Code gets only a
static "Compact Instructions" section the installer offers to add to the user's `CLAUDE.md`.

**C4. Tail policy is enforced where the host allows and advised elsewhere.**
- Kilo: enforced natively (`messages.transform` stubs old tool results; `compaction.prune` already
  does a version of this).
- Claude Code: `PostToolUse.updatedToolOutput` can shrink any result *as it enters* context (cap
  large outputs, reduce subagent reports to their structured handback — see C5). Old results cannot
  be retro-stubbed; the host's own pruning and compaction handle that.
- Codex: `PostToolUse` replacement is destructive (`block` + feedback), so the adapter relies on
  `tools.<t>.output_token_limit` for MCP tools and on MCP-side caps; no retro-stubbing.

**C5. Structured handback.** Worker rules require the final message to end with a fenced
`hafiz-report` block (outcome, progress written, blockers, open threads — all ≤ caps). Where the
host lets the adapter rewrite the Agent/Task result (Claude Code `updatedToolOutput` — to verify;
Kilo `tool.execute.after`), only that block reaches the parent. Where it cannot (Codex), the parent
rules say to read only the block. The worker has already written its progress to Hafiz, so the
parent needs little else.

**C6. The proxy is optional, not load-bearing.** Every host has native injection and re-injection
after compaction; Kilo has native rewrite. The proxy remains the way to get Kilo-grade tail control
on Claude Code and Codex, and a fallback if a host's hooks regress. It is phase 2. If built, it
must: forward `anthropic-*`/`cache_control`/SSE pings unchanged (Claude Code), speak the Responses
API (Codex), and never touch tool definitions or the newest user turn.

**C7. Elicitation fallback is required**, not theoretical: Kilo lacks it. `block.set_status(done)`
returns `needs_confirmation` with instructions there; uses elicitation on Claude Code and Codex.

**C8. Installer writes user-level settings; plugins cannot.** Claude Code plugins cannot set
permissions or env; Codex `model_providers`/profiles are user-level only. So `hafiz install <host>`
is a CLI step that edits user settings (allow-all for Hafiz servers, deny rules for the store path,
optional compaction thresholds), separate from plugin installation.

---

## 3. Adapter designs

Every adapter is generated from the same config (`roles.yaml`, `views.yaml`, `rules/`) and does the
three jobs from ARCHITECTURE §12: **install**, **observe**, **act**.

### 3.1 Claude Code (`host-claude-code/`) — a plugin + an installer step

| Job | Mechanism |
|---|---|
| Install (plugin) | `plugin.json`; `.mcp.json` registering `hafiz mcp --role <r>` per role as `hafiz-<role>` servers; `agents/<role>.md` generated from `roles.yaml` with `tools:` = built-ins the role needs + `mcp__plugin_hafiz_hafiz-<role>__*` and `disallowedTools:` for the other Hafiz servers; `skills/hafiz-<role>/SKILL.md` carrying the role's rules; `hooks/hooks.json`; commands `/hafiz:init`, `/hafiz:status`, `/hafiz:direct`, `/hafiz:park` |
| Install (user settings, via `hafiz install claude-code`) | `permissions.allow: ["mcp__plugin_hafiz_*__*"]`; `permissions.deny: ["Read(~/.hafiz/**)", "Edit(~/.hafiz/**)", "Bash(* ~/.hafiz*)"]`; optional `autoCompactWindow`; offer to append a "Compact Instructions" section to `~/.claude/CLAUDE.md` |
| Observe | `UserPromptSubmit` → `turns++`; `PostToolUse` → `tool_calls++`, files written (Edit/Write), `subagents_spawned` (Agent); `SubagentStop` → mark worker session done; `PostCompact` → note compaction (telemetry) |
| Act: inject | `SessionStart` (all matchers) → `additionalContext` = `context.for(session)`; `UserPromptSubmit` → if epoch changed since last injection, append fresh envelope; else inject only pending notices (nudge, "focus too wide") |
| Act: shape results | `PostToolUse` on `Agent` → `updatedToolOutput` = handback block only (if verified); on `Bash`/`Read` results over a cap → head/tail stub with size (config-gated, off by default) |
| Session identity | `session_id` from hook input; MCP connection ↔ hook session unified via `CLAUDE_PROJECT_DIR` + `x-claude-code-session-id`-equivalent env where available, else per-project default session |
| Compaction | nothing to steer; `SessionStart(compact)` re-injects; `PreCompact` is used only for telemetry |

Limits: cannot retro-stub old tool results; cannot replace the envelope in place (append-only);
plugin cannot set permissions (installer does).

### 3.2 Codex (`host-codex/`) — a plugin + an installer step

| Job | Mechanism |
|---|---|
| Install (plugin) | `plugin.json`; `mcp.json` with the role servers; `hooks/hooks.json`; `skills/hafiz-<role>/SKILL.md` (role rules — plugins cannot ship AGENTS.md) |
| Install (user config, via `hafiz install codex`) | `mcp_servers.hafiz-<role>` entries (stdio, `default_tools_approval_mode = "auto"`, `tools.*.output_token_limit`); custom agents TOML in `~/.codex/agents/<role>.toml` with `developer_instructions` = role rules; optional `compact_prompt` = Hafiz compaction prompt; optional `~/.codex/<role>.config.toml` profiles for hard role separation across processes |
| Observe | `UserPromptSubmit`, `PostToolUse`, `SubagentStart/Stop` hooks → counters |
| Act: inject | `SessionStart` (incl. `source=compact`) and `UserPromptSubmit` `additionalContext`, same append-only strategy as Claude Code; `additionalContextLimit` raised for the envelope |
| Act: shape results | none in-band (PostToolUse replacement is destructive); rely on `output_token_limit` and MCP-side caps; parent rules read only the handback block |
| Role enforcement | advisory within one session (shared MCP servers across subagents); `PreToolUse` deny by `agent_type` if the input carries it (to verify); hard separation only via profiles |
| Compaction | `compact_prompt` set to the Hafiz prompt ("preserve nothing the `<hafiz>` envelope covers; keep user intent and unfinished tail"); `SessionStart(compact)` re-injects |

Limits: no per-subagent MCP restriction; no in-band result shaping; Responses wire only (matters
only for the optional proxy).

### 3.3 Kilo (`host-kilo/`) — a TypeScript plugin

| Job | Mechanism |
|---|---|
| Install | one plugin module (works in CLI and VS Code); `config` hook injects: `mcp.hafiz-<role>` servers, `agent.<role>` definitions (prompt = role rules, `permission` map allowing only `hafiz-<role>_*` and denying other `hafiz-*_*`, `permission.task` to control who may delegate to whom), slash commands, `permission.edit/read` deny for the store path, `instructions` entry pointing at the Hafiz rules file |
| Observe | `event` hook: `session.created/idle/compacted`, `tool.execute.after`, `file.edited` → counters |
| Act: inject | `experimental.chat.system.transform` → envelope at the end of the system prompt, replaced in place on epoch change (prefix-stable, no stale copies) |
| Act: tail | `experimental.chat.messages.transform` → stub tool results older than `tool_result_max_age_turns`, never user turns, never the newest turn; complements `compaction.prune` |
| Act: shape results | `tool.execute.after` on `task` → keep handback block; cap large tool outputs |
| Compaction | `experimental.session.compacting` → `output.prompt` = Hafiz compaction prompt; `session.compacted` → re-render (system transform already carries the envelope, so nothing is lost) |
| `done` confirmation | `needs_confirmation` fallback (no elicitation) |

Limits: the three key hooks are experimental; the adapter degrades to Claude-Code-style
append-only injection via `chat.message` if they disappear.

---

## 4. Where the hosts bend the core

Facts above that leak into the host-agnostic design (recorded so they are deliberate):

- **Envelope must be self-describing** (`epoch`, `focus_epoch`, `role`, project) so stale copies can
  coexist with a fresh one on append-only hosts (C2).
- **Role is carried by the server instance**, and additionally declared per session so Core can
  authorize even when the host cannot hide tools (C1).
- **Core needs a "pending notices" queue per session** that injection hooks drain (nudge,
  focus-too-wide, confirmation-required), because hosts offer injection points at fixed moments.
- **Structured handback** is part of the worker protocol, not an adapter trick (C5).
- **`needs_confirmation` is the primary `done` path in the protocol**; elicitation is an upgrade.
