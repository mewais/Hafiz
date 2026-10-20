# Hafiz — Design Notes

Condensed record of the problem framing and the decisions behind [`ARCHITECTURE.md`](ARCHITECTURE.md),
including the revisions made after an independent adversarial review of the first draft.

## Problem

In a manager / designer / planner / workers flow on a large project, the manager's context fills
with material whose usefulness expires immediately: tool calls, subagent reports, implementation
details of finished work, side conversations with the user. Generic compaction summarizes all of it
uniformly, so the manager "remembers" the wrong things and forgets the architecture.

What should happen instead is determined by **project structure** (architecture → blocks →
sub-blocks) and **work state** (planned / active / done), not by recency or a summarizer's judgement.

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Context is a **view over a block tree**, parameterized by per-consumer **focus**, **role**, **budget**. Status is global, focus is per-consumer; focus is **computed per role** by default. | Every agent gets exactly its slice; the manager stops pasting designs into worker prompts; agents don't have to remember to set focus. |
| 2 | **Context is rebuilt every request, host compaction is disabled.** Prefix = rendered view + floor; tail = bounded unfiled summary + verbatim recent turns + delta. | Deterministic for structure; the one thing that needs an LLM (unfiled conversation) gets exactly one, budget-triggered. |
| 3 | **Re-emit the prefix only when its rendered text changes** (content hash per session), not per epoch; epoch is an internal invalidation signal. | Per-epoch re-emission churns prompt caches at scale for consumers whose view did not change. |
| 4 | **Explicit state protocol** as the primary path; **mechanical compliance checks and automatic report capture** as the safety net; LLM proposals as the last net. | Agents will miss calls; silent loss is the catastrophic mode. Detection must not depend on an LLM. |
| 5 | **Hafiz is the only copy** of designs/plans, stored **outside the repo**, personal, **git-backed** with attributed commits per agent session. | Protects design docs; history/diff/rollback/backup; "protection" inside the repo is fiction. |
| 6 | **Role = MCP server instance**, plus per-session capability tokens and an audit log. Enforcement is best-effort and documented as such. | Server-level hiding is universal across hosts; an MCP server cannot authenticate callers; visibility beats false guarantees. |
| 7 | **Blackboard**: append-only logs + CAS on docs, journaled multi-file transactions, one daemon per project. Step status is an append-only event, not a CAS patch. | Parallel workers are the normal case; ticks must never conflict. |
| 8 | **Tree + dependency edges** with bounded transitive propagation; `interface` a required design section; `external` stub blocks for un-imported code. | Dependents keep working against done blocks and brownfield code alike. |
| 9 | **Everything structured**, schemas selected by **block kind**, caps with a soft zone, explicit schema versioning and migration. | Free-form drifts; one schema does not fit root/research/component. |
| 10 | **No tree → zero cost.** Tree creation is explicit (user, agent under rules, counter nudge). | Harmless for small tasks. |
| 11 | **Budget**: caps at write time; deterministic periphery-inward degradation; floor measured separately with its own cap; demotion to on-demand; "focus too wide" notice. | Bounded and predictable; the floor is advisory and says so. |
| 12 | **Live discussions**: user turns never stubbed; **tail condensation** when the tail overflows produces a rolling unfiled summary + proposals; thread park/resume; counter notice for long un-threaded discussions. | Conversations survive until filed; nothing is dropped without a trace. |
| 13 | **Decisions subsume directives**: a decision with `standing` renders in the never-degraded floor; active root/ancestor decisions render at DESIGN; superseded ones vanish. | Architectural decisions must reach every worker; agents should not choose between two tools. |
| 14 | `done` is agent-declared; default **`confirm_done: auto` + non-blocking review queue**; `done → active` reopen exists; `done_at.commit` recorded for drift detection. | User mostly out of the loop; autonomous runs must not stall; finished blocks get reopened in real projects. |
| 15 | **LLM policy: none per turn.** Condenser at tail overflow (produces summary + proposals), opt-in drafters at explicit events (digest, gist). Output is never store truth without an agent/user action. | Keeps the assembler dumb and cost bounded while covering what only an LLM can see. |
| 16 | **Config over code** for roles, views, zooms, kinds, schemas, guards, compliance, nudge, tail; `context.explain` ships day one. | Extensible without inheritance; policy must be debuggable. |
| 17 | **Kilo-first.** v1 adapter is a Kilo plugin with a `RequestShaper` that uses the transform hooks when present and an embedded in-process proxy otherwise. Claude Code / Codex append-only mode is specified, not built. | Kilo is the only host where every principle is implementable natively; its best hooks are experimental, so a stable fallback is required. |
| 18 | Sessions keyed by **host session id** and persisted. | Focus and counters must survive resume, reconnect and spawn. |
| 19 | Data in home, **pointer with origin fingerprint** in the repo; daemon refuses to auto-create a store for a foreign pointer. | Avoids worktree/clone fragmentation and silent divergent stores. |
| 20 | **Cost instrumentation from day one** and a **protocol compliance harness** before tuning. | The thesis is "cheaper and better than summarization"; it must be measured. |
| 21 | Brownfield: **import what you touch, stub what you call.** | No importer code path; partial adoption is the realistic path. |

## Explicitly deferred

- Team sharing / merging of stores (git-backed store makes this a remote + merge policy later).
- Search across the tree.
- Claude Code and Codex adapters (append-only mode, HOST-MATRIX §3).
- Prior-art write-up (OpenViking, mem0, memory banks are retrieval-shaped; Hafiz is work-state-shaped).

## What the adversarial review changed

Accepted: compaction cliff → tail ownership + condenser; silent non-compliance → compliance checks
+ report capture; epoch churn → content-hash re-emission; minor writes invisible → delta channel;
no reopen → `done → active`; step ticks as CAS → step events; decisions outside focus → merge with
directives, DESIGN-level rendering; claimed role → tokens + audit; no history → git-backed store;
session identity → host id; fs transactions → journal; schema evolution → versioning + migrate;
relation for focus sets → max-zoom aggregation + `dep_distance`; schema by kind; digest authorship
→ `request_done`; external stubs; pointer fingerprint; `blocked_on`; `confirm_done: auto`;
commit at done; floor cap; no-tree short-circuit; tokenizer margin; cost model.

Rejected or superseded: the review assumed a proxy-centric design and no host matrix; the verified
matrix made the proxy optional and (for Kilo) in-process. Its claims that a proxy cannot identify
Claude Code subagents or carry OAuth are contradicted by current docs.
