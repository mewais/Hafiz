# Hafiz — Design Notes

Condensed record of the problem framing and the decisions behind [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Problem

In a manager / designer / planner / workers flow on a large project, the manager's context fills
with material whose usefulness expires immediately: tool calls, subagent reports, implementation
details of finished work, side conversations with the user. Generic compaction summarizes all of it
uniformly, so the manager "remembers" the wrong things and forgets the architecture.

What should happen instead is determined by **project structure** (architecture → blocks →
sub-blocks) and **work state** (planned / active / done), not by recency or by a summarizer's
judgement:

- architecture and block designs: always present, verbatim
- active blocks: design, plan, progress, open threads
- finished blocks: a digest and their interface; implementation details gone
- side discussions: ephemeral unless they produce a decision
- subagent reports: outcome kept, detail routed to the block's progress notes

## Decisions

| # | Decision | Why |
|---|---|---|
| 1 | Context is a **view over a block tree**, parameterized by per-consumer **focus**, **role**, **budget**. Status is global, focus is per-consumer. | Every agent (not just the manager) gets exactly its slice; the manager stops pasting designs into worker prompts. |
| 2 | **Compaction is assembly**, not summarization. Rebuilt context = rules + rendered view + open-thread lines + verbatim tail. | Deterministic, cheap, testable; no ambient LLM. |
| 3 | **Epoch-based**, not per-turn, rewriting. | Per-turn rewriting breaks prompt caching and can cost more than it saves. |
| 4 | **Explicit state protocol.** Agents call `set_status`, `record_decision`, `note_progress`, `park_thread`. No background LLM inferring state. | Keeps Hafiz dumb and cheap; the inference is where spend and drift come from. A user-invoked audit may come later. |
| 5 | **Hafiz is the only copy** of designs/plans, stored **outside the repo**, personal. | Protects design docs from casual edits; "protection" inside the repo is fiction. External references allowed, never mirrored. |
| 6 | **Role enforcement at the host** (per-agent tool allowlists) + versioning in Hafiz. | An MCP server cannot authenticate callers; the host can hide tools. |
| 7 | **Blackboard** pattern: agents don't message each other; they keep the board current. Append-only logs + CAS on docs, one daemon per project. | Parallel workers are the normal case; atomicity across hosts. |
| 8 | **Tree + dependency edges**, `interface` a required design section. | Done blocks' interfaces stay visible to dependents; works for any kind of project. |
| 9 | **Everything structured** (schemas, section caps). | Free-form drifts; structure makes rendering, degradation and digests mechanical. |
| 10 | **No tree → zero cost.** Tree creation is explicit: user command, agent under the rules contract, or a counter-based one-line nudge. | Must be harmless for small tasks; the nudge is the backstop, the contract is the primary path. |
| 11 | **Budget**: caps at write time, deterministic zoom degradation periphery-inward, demotion to on-demand (`read_block`), "focus too wide" notice. | Bounded by construction; overflow is predictable and reversible; the fix for real overflow is structural (deeper tree / delegation). |
| 12 | **Live discussions**: verbatim tail + epoch persistence + explicit `park/resume`. | Conversations survive until the work they belong to moves on; parking costs two tool calls. |
| 13 | `done` is agent-declared with **MCP elicitation** confirmation (`ask`/`auto`), with a host-agnostic fallback. Digest written by the finishing agent. | User mostly out of the loop; confirmation is the moment to catch stray threads. |
| 14 | **Config over code** for roles, views, zooms, schemas, guards, nudge. Code supplies interfaces (backend, tokenizer, renderer, validators, predicates). | Extensible without inheritance hierarchies; experiments are config diffs. |
| 15 | Brownfield: **import what you are about to touch**, via the designer agent using normal write tools; the rest is "the existing codebase" referenced from root. | No importer code path; partial adoption is the realistic path. |

## Explicitly deferred

- Team sharing / merging of stores (export/import snapshots only in v1).
- LLM-assisted audit of transcripts against the tree (user-invoked, never ambient).
- Search across the tree.
- Prior-art comparison write-up (OpenViking, mem0, memory banks): those are retrieval-shaped
  memory; Hafiz is work-state-shaped context assembly. Worth a short section later.
