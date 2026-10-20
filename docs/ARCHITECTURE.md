# Hafiz — Architecture

Hafiz (حافظ, *the one who memorizes; the guardian*) is a work-state-aware context manager for
multi-agent coding sessions. It keeps a project's architecture, block designs, plans, status,
decisions and open threads in a structured, versioned store that agents maintain through a small,
role-scoped tool protocol, and it rebuilds each agent's context on every request from that store —
deterministically, with LLM help only at budget-triggered checkpoints and only to produce proposals.

Design rationale is in [`DESIGN-NOTES.md`](DESIGN-NOTES.md); verified host capabilities in
[`HOST-MATRIX.md`](HOST-MATRIX.md). Target host for v1 is **Kilo Code (current, OpenCode-based)**;
the core is host-agnostic and an append-only mode for Claude Code / Codex is specified but not built.

---

## 1. Principles

1. **Status is global, focus is per-consumer.** A block is `done` for everyone; *what you are
   looking at* is yours. Context = a view over the tree parameterized by (focus, role, budget).
2. **Context is rebuilt, not compacted.** Every request's message array is assembled: structured
   view from the store + a bounded verbatim tail + a bounded "unfiled context" summary. Host
   compaction is disabled for managed sessions; it never fires because the context never overflows.
3. **Structure changes rarely; the tail changes constantly.** The view is re-emitted only when its
   rendered text changes; the tail is append-only between condensations. This keeps prompt caches
   valid and Hafiz cheap.
4. **Hafiz is canonical, private, and versioned.** Designs and plans live only in Hafiz, outside the
   repo, in a git-backed store where every write is attributed to a session and committed.
5. **No tree → zero cost.** A project without a tree gets nothing injected, nothing rewritten, and
   no process spawned beyond a cached "no tree" check.
6. **Everything structured.** Documents are schema'd sections with caps; schemas are selected by
   block kind. Structure makes rendering, degradation and digests mechanical.
7. **No LLM per turn.** LLMs run only at explicit, budget-triggered checkpoints (tail condensation)
   or opt-in explicit events (drafters), and only produce bounded summaries or *proposals* that land
   in a review queue. Nothing an LLM writes becomes store truth without an agent or user action.
8. **Non-compliance must be visible.** Agents will miss protocol calls. Hafiz detects it
   mechanically from counters and captures what it can (worker reports) without asking.
9. **Config over code.** Roles, views, zooms, schemas, guards, budgets, nudges are configuration.
10. **Nothing is lost, only demoted.** Overflow turns "in context" into "one `read` away".
11. **Enforcement is best-effort and says so.** Roles are enforced by the host hiding tools and by
    Core checking a per-session capability token; violations are attributed and visible, not
    cryptographically prevented.

---

## 2. Layered overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HOST ADAPTERS         kilo/ (v1)          claude-code/, codex/ (specified)  │
│  generated from config; bridge host events → core; shape each request       │
├──────────────────────────────────────────────────────────────────────────────┤
│  GATEWAYS              mcp/ (per role)     cli/                              │
│  protocol surfaces; translate wire → Core API; no business logic             │
├──────────────────────────────────────────────────────────────────────────────┤
│  CORE (one daemon per project)                                               │
│   Domain · Schemas · Commands/Queries · Authz · View engine · Tail policy    │
│   Sessions · Compliance · Condenser (LLM checkpoint) · Review queue · Events │
├──────────────────────────────────────────────────────────────────────────────┤
│  SPI                                                                         │
│   StorageBackend · Tokenizer · Renderer · LLMProvider · ConfigSource · Clock │
│   impls: storage-fs (git-backed, default) · storage-sqlite · …               │
└──────────────────────────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point down only. Core knows nothing about MCP, HTTP or any host. The
`RequestShaper` (the thing that rewrites a model request) lives in the adapter and calls Core.

---

## 3. Core: domain model

Identifiers are stable human-readable slugs with a random suffix (`billing-7f2a`).

### 3.1 Entities

| Entity | Fields (abridged) | Mutability |
|---|---|---|
| `Project` | id, name, origin_fingerprint, root_block_id, schema_set_version, epoch | epoch on major writes |
| `Block` | id, parent_id, title, **kind**, status, blocked_on?, order, version, done_at{commit?, ts}? | CAS on `version` |
| `Edge` | from, to, kind (`depends_on` default; extensible) | add/remove |
| `Doc` | block_id, type (`design`\|`plan`\|`digest`\|…), version, sections{} | CAS; validated against the schema selected by block kind |
| `StepEvent` | block_id, step_id, status, session_id, ts | append-only; folded into the rendered plan |
| `ProgressEntry` | block_id, ts, session_id, role, kind (`done`\|`blocked`\|`found`\|`changed`\|`question`\|`report`), text, refs[] | append-only |
| `Decision` | id, block_id, ts, title, decision, rationale, **standing?** (`never`\|`always`\|`prefer`), status (`active`\|`superseded`), supersedes?, by | append-only; supersede, never edit |
| `Thread` | id, block_id, title, gist, status (`open`\|`parked`\|`resolved`), entries[] | append-only entries |
| `Proposal` | id, kind (`decision`\|`thread`\|`progress`\|`digest`\|`gist`\|`status`), payload, source (`condenser`\|`drafter`\|`compliance`), status (`pending`\|`accepted`\|`rejected`) | the review queue |
| `Session` | id (= host session id, persisted), project_id, host, role, token, focus{blocks[], order?, computed: bool}, counters, last_view_hash, unfiled_summary | persisted; reconnects re-attach |
| `AuditEntry` | ts, session_id, role, command, target, version_before/after, commit | append-only, mirrors git log |

**Block kinds** are config-defined (`kinds.yaml`): each names the schema set to use for its docs and
optional view overrides. Defaults: `root` (architecture: overview, topology/data-flow, interface,
constraints, references), `component` (purpose, scope, interface, constraints, rationale),
`feature`, `research` (question, findings, conclusion), `doc`, and **`external`** (interface only —
a stub for code that exists but was never imported, so edges can point at it).

**Decisions subsume directives.** A decision with `standing` set is a standing instruction ("never
commit generated files"); it renders in the view **floor** for the focus and all its ancestors at
every zoom and is never degraded. Decisions without `standing` are records; the *active* ones of
root and ancestors render at `DESIGN` zoom, capped, newest first. Superseded decisions render
nowhere. A per-block cap on active standing decisions triggers a "consolidate" notice.

### 3.2 Status machine

```
planned ──▶ active ◀──▶ blocked (blocked_on: block | thread | user | external)
   │          ▲  │
   │          │  ▼
   │          └─ done        (done → active = reopen; reason recorded as a decision,
   ▼                          digest marked stale and required again on re-close)
dropped  ◀── (any, reason recorded as a decision)
```

Guards are config (`policies.status`), composed from registered predicates. Defaults:

- `→ done`: a `digest` present and not stale; no `open` threads; children `done`/`dropped`;
  `confirm_done` policy (default **`auto`** — proceeds and enqueues a `status` proposal for review;
  `ask` uses elicitation where the host has it, else returns `needs_confirmation`).
  Records `done_at.commit` (repo HEAD) for later drift detection.
- A worker may `block.request_done(id, digest)`: writes the digest and enqueues the transition for
  the manager (or auto-applies under `auto` if the role policy allows).
- `→ blocked` requires `blocked_on`. `→ active` from `blocked` clears it.
- `→ active` on a block whose parent is `planned` activates the parent (configurable).

### 3.3 Epochs and re-emission

- `project.epoch` increments on **major writes**: block create/drop/move, status change (`done`
  and reopen included), design/plan content, decisions, edges, step *definitions*.
- **Minor writes** do not bump it: progress entries, step events, thread open/entries/park/resolve.
- The epoch is an **internal invalidation signal**, not a wire attribute. A session's view is
  re-rendered when the epoch or its focus changed, and **re-emitted only if the rendered text's hash
  differs from `session.last_view_hash`**. A worker on a distant leaf sees no re-emission for
  activity that does not change its view. The envelope carries the hash, not the epoch.
- Minor writes reach the consumers that coordinate on them through the **delta channel** (§6.5),
  which lives in the tail and never touches the prefix.

---

## 4. Core: schemas

A **schema set** is a directory of YAML files (one per doc type per kind); `kinds.yaml` maps kinds to
sets. Sections carry `required`, `cap` (tokens), `format` (`prose`\|`list`\|`structured`\|`steps`\|
`refs`). Example (component design):

```yaml
type: design
kind: component
sections:
  - { name: purpose,     required: true,  cap: 150, format: prose }
  - { name: scope,       required: true,  cap: 200, format: list }
  - { name: interface,   required: true,  cap: 600, format: structured }   # provides/consumes/contracts
  - { name: constraints, required: false, cap: 200, format: list }
  - { name: rationale,   required: false, cap: 300, format: prose }
  - { name: references,  required: false, cap: 100, format: refs }
```

- **Caps** have a soft zone: within `+15%` of the cap a write succeeds with a notice (tokenizer
  variance across vendors is 10–20%); beyond it, reject with the measured size and the remedy
  ("split into child blocks" / "move detail to progress"). Per-block cap overrides are allowed and
  recorded as a decision.
- **Schema versioning.** The schema set declares `schema_version` (`hafiz.yaml`) and the project pins
  it (`schema_set_version`). Reads are lenient (unknown sections kept, missing required sections
  flagged, not failed); `hafiz doctor` lists docs that fail the loaded set. `hafiz migrate
  [--dry-run]` upgrades docs explicitly, as the user, in one transaction, following declarative
  `migrations/<from>-<to>.yaml` files in the schema set: `rename_section`, `add_section` (with a
  default), `drop_section`, and `map_kind` (a kind's doc type moves to another schema). It refuses
  to run if any migrated doc would still fail validation. Writes validate against the loaded set;
  the pin tells `doctor` and `migrate` where the stored docs are.
- Logs (`StepEvent`, `ProgressEntry`, `Decision`, `Thread`) have fixed small shapes with per-entry
  caps.

---

## 5. Core: commands, queries, authorization

### 5.1 Commands

| Command | Semantics |
|---|---|
| `project.init(name, root_design?)` | create project + root; write pointer; init git store |
| `block.create(parent, title, kind, design?, plan?)` | atomic (journaled) |
| `block.update / block.move` | CAS; epoch |
| `block.set_status(id, status, {digest?, reason?, blocked_on?, confirmed?})` | guards; `done→active` allowed |
| `block.request_done(id, digest)` | worker path; enqueues or auto-applies |
| `edge.add / edge.remove` | epoch |
| `doc.write / doc.patch(block, type, …, expected_version)` | full/section replace; validate; CAS; epoch |
| `step.set(block, step_id, status)` | append-only event; no epoch; no CAS |
| `progress.append(block, entry)` | append-only |
| `decision.record(block, {title, decision, rationale, standing?, supersedes?})` | append-only; epoch |
| `thread.open / park(gist) / resume / resolve` | minor |
| `focus.set(session, blocks, order?)` | overrides computed focus |
| `proposal.accept / reject(id)` | review queue; `accept` performs the proposed command as the accepting session |

Stale `expected_version` → `Conflict{current}`. All commands are journaled transactions; every
successful command produces an `AuditEntry` and (major writes) a git commit authored as
`<role>/<agent-name> <session-id@hafiz>`; CLI writes are authored as the user.

### 5.2 Queries

| Query | Semantics |
|---|---|
| `context.for(session)` | → `{envelope, hash, floor, notices}` (§6) |
| `context.delta(session)` | minor events on focus + dependencies since last delivery (§6.5) |
| `context.explain(session, block)` | which rule fired, which degrade steps applied, why |
| `block.read(id, zoom)` / `tree.list(…)` / `thread.list(…)` / `proposal.list(…)` | |
| `history(block, type)` | git log/diff of a doc |
| `session.status(session)` | counters, compliance flags, hash, unfiled size |

### 5.3 Authorization

A role (config) carries a command allowlist (`doc.write:design`, `block.set_status:done`, …).
Each session holds a **capability token** minted by the adapter at spawn (passed via env to the
MCP shim/CLI); Core maps token → session → role. The host additionally hides tools per role
(role = MCP server instance, §11.1). Writes outside this path (editing store files by hand under a
running daemon) are detected by the git working-tree check on the next command and surfaced as a
notice; they are not prevented.

---

## 6. Core: the view engine and the tail

`context.for` builds the **structured prefix**; the tail policy and condenser govern the **tail**.

### 6.1 Pipeline

```
Relate ─▶ Policy ─▶ Render ─▶ Degrade ─▶ Floor ─▶ Hash
```

- **Relate**: for *each* focus block compute `relation ∈ {root, focus, ancestor, descendant,
  dependency, dependent, sibling, other}` and `dep_distance` (shortest dependency path; config
  caps propagation depth, default 2). Aggregate across the focus set by **max zoom wins**.
- **Policy**: first-matching rule assigns a zoom (+ optional `floor` = never below).
- **Render**: zoom → ordered section selectors → `Renderer` (Markdown, stable headings, ids).
- **Degrade**: if over budget, apply the view's ordered steps until it fits; emit "focus too wide"
  if still over.
- **Floor**: append standing decisions for focus + ancestors; the floor has **its own cap** and is
  measured separately — the budget is advisory for the floor, and a floor over its cap is a
  "consolidate" notice, not a degradation.
- **Hash**: content hash of the final text; drives re-emission.

### 6.2 Zoom levels (`zooms.yaml`)

```yaml
zooms:
  FULL:      [block.header, design.*, plan.* (with step events folded), decisions.active[-5:],
              progress[-10:], threads.open, threads.parked.titles]
  DESIGN:    [block.header, design.*, decisions.active[-3:]]
  INTERFACE: [block.header, design.interface, status.line]
  DIGEST:    [block.header, digest.*, design.interface]
  LINE:      [block.line]
  NONE:      []
floor:
  - { match: { relation: [root, focus, ancestor] }, sections: [decisions.standing], cap: 600 }
```

### 6.3 View policy (`views.yaml`) — default

```yaml
views:
  default:
    budget: { share_of_window: 0.30, min_tokens: 3000, max_tokens: 24000 }   # excludes floor
    rules:
      - { match: { relation: root },                        zoom: DESIGN, floor: DESIGN }
      - { match: { relation: focus },                       zoom: FULL }
      - { match: { relation: ancestor },                    zoom: DESIGN }
      - { match: { relation: dependency, status: done },    zoom: DIGEST }
      - { match: { relation: dependency, dep_distance: 1 }, zoom: INTERFACE }
      - { match: { relation: dependency },                  zoom: LINE }
      - { match: { relation: descendant, status: active },  zoom: INTERFACE }
      - { match: { status: done },                          zoom: DIGEST }
      - { match: { status: dropped },                       zoom: NONE }
      - { default: LINE }
    degrade:
      - { match: { status: done, relation: other },         to: LINE }
      - { match: { relation: sibling },                     to: NONE }
      - { match: { relation: ancestor },                    to: INTERFACE }
      - { match: { relation: focus }, trim: { progress: 3, decisions: 2 } }
      - { match: { relation: focus }, to: DESIGN, order: focus_reverse }
  worker:
    extends: default
    budget: { share_of_window: 0.20 }
```

Everything in `match` is an attribute Relate computed; new attributes need no engine change.
`context.explain` exists because first-match + extends + degrade is not debuggable from YAML alone.

### 6.4 Computed focus

Focus is set by the adapter at spawn from the role's `focus_policy` (`worker: spawned_block`,
`manager: all_active`, `designer: all_active + planned_children`) and persisted on the session;
`focus.set` overrides it. Agents do not have to remember to set focus.

### 6.5 The tail: ownership, policy, delta, condensation

Hafiz owns the tail on Kilo (it rewrites the message array). Per request:

```
[system: host prompt + <hafiz hash=…> envelope + floor]
[unfiled context: rolling summary, ≤ tail.unfiled_cap]           ← produced by the condenser
[verbatim tail: last turns within tail.budget]                    ← user turns never stubbed
   tool results older than tail.tool_result_max_age_turns → "[elided: 4.2k tokens — Bash]"
[delta: minor events on focus + deps since last delivery, ≤ cap] ← appended before the newest user turn
[newest user turn]                                                ← never touched
```

- **Delta channel**: step events, progress, thread changes on the session's focus blocks and their
  dependencies, since the session last received them. Capped; overflow → "N more, `block.read`".
  This is how Worker A learns Worker B's `found:` without an epoch.
- **Condensation** (the only in-loop LLM): triggered when the verbatim tail exceeds `tail.budget`
  (or by `/hafiz checkpoint`). Input: previous unfiled summary + the slice of turns leaving the
  tail. Output, from a cheap model via `LLMProvider`: (1) the new unfiled summary — verbatim-ish
  preservation of user intent, open questions and in-flight reasoning that no store entity
  covers; the envelope's content is explicitly excluded; (2) **proposals** — candidate decisions,
  threads to open/park, progress entries, for anything the agents should have recorded and did
  not. Proposals go to the review queue; nothing is written to the store. Cost is bounded by
  construction: each slice is condensed once.
- A counter-based notice fires when a user exchange has run `N` turns with no thread opened on
  the focus block.
- **As built (M5).** The shaper asks `shapeTail`; when it returns `condense` it calls the daemon's
  `condense` method **without waiting**: the current request goes out with the un-condensed tail,
  the next one finds the summary. One condensation per session at a time. The daemon runs it
  beside its serial request chain (an LLM call must not stall tool calls); its single store write
  re-reads the session. `/hafiz-checkpoint` and `hafiz checkpoint` set `checkpointRequested` on
  live sessions; the next shaping then condenses everything before the newest user turn.
  - *Cursor.* A condensation stores `session.condensed = {index, fingerprint}` for the last turn
    it folded (sha256 of `role\0content` of the host's own, unstubbed turn). Every later shaping
    drops the host turns up to that turn before `shapeTail` runs; the fingerprint decides, the
    index is only a tie-breaker. So the cut is a pure function of (conversation, stored cursor):
    two shapes of the same conversation are byte-identical, and a cursor that cannot be found
    drops nothing (the summary is then redundant, never lossy).
  - *Failure.* Unparseable output, an empty summary that would erase a previous one, or a provider
    error keep the previous summary and cursor, count `condense_failures`, and queue a warn
    notice. The condenser tolerates fenced JSON; it drops malformed proposals individually, caps
    them at six, truncates an over-cap summary (newest lines kept), and proposals need a block
    (default: the session's first focus block) that exists.
  - *No provider.* With `llm.condenser.provider: none` nothing condenses and the tail grows, so
    the plugin leaves Kilo's own compaction as the user set it; it sets `compaction.auto: false`
    only when a condenser is configured.
  - *Notices ride the tail.* Queued notices (compliance, nudge, proposals) are drained by the
    shaper into the same inserted turn as the delta, so a session that never calls a Hafiz tool
    still hears them.

### 6.6 Engine conventions (as built in M2)

- **Relation precedence** when several hold for one focus block: `root > focus > ancestor >
  dependency > descendant > dependent > sibling > other`. `dep_distance` is the shortest
  `depends_on` path from the focus block, bounded by the view's `dependency_depth`; `dependent`
  uses the same bound in reverse. Rule `match` keys are arbitrary Relate attributes (`relation`,
  `status`, `kind`, `depth`, `dep_distance`); a list value means any-of.
- **Aggregation**: rules are evaluated per focus block; the most detailed zoom wins (zoom order =
  key order of `zooms.yaml`), ties go to the higher-precedence relation. The winning evaluation's
  attributes are what non-ordered `degrade` steps match; `order: focus_reverse` steps match per
  focus block, lowest priority (`focus.order`, else `focus.blocks`, reversed) first, re-measuring
  after each. A rule `floor` holds across all evaluations (most detailed wins).
- **Connectors**: a block at `NONE` with a visible descendant is shown at the next-to-least zoom
  (`LINE`) so every visible block's path stays intact.
- **Rendering**: one heading per visible block, depth-based level, `Title [id] status · marks`
  (marks: `focus`, `dependency`, non-default kind); sections are labelled lines, never headings;
  missing docs and empty sections render nothing; superseded decisions render nowhere and standing
  ones only in the floor; runs of heading-only blocks are not blank-line separated.
- **Wire**: `<hafiz hash="…" role="…">` wraps notices (`> warn: …`) and the view;
  `<hafiz-floor>` carries standing decisions; `<hafiz-delta>` and `<hafiz-unfiled>` are tail
  turns. The hash (sha256, 12 hex) covers the view **and** the floor, so a new standing decision
  re-emits. Budget is measured on the view only.
- **Delta**: the session's own progress/step events are not echoed back; repeated events on the
  same step or thread collapse to the latest. `context.for` initialises the cursor (the view already
  carries recent history); `context.delta` advances it.

---

## 7. Core: sessions, compliance, nudge, drafters, events

- **Sessions** are keyed by the **host session id** and persisted; MCP reconnects and `resume`
  re-attach to the same session (focus, counters, hash, unfiled summary intact). Subagent sessions
  record their parent.
- **Counters** (`turns`, `tool_calls`, `files_written`, `subagents_spawned`, `tokens_in/out`,
  `cache_read/write`) are fed by the adapter; Core never observes the host.
- **Compliance checks** (config `compliance.yaml`), evaluated on counter updates, `request_done`
  and session end:
  `files_written > 0 ∧ progress == 0`; active focus block silent for `N` turns; session ending with
  threads it opened still `open`; `request_done` with an empty progress log; cap rejections
  followed by no retry. Each yields a notice to the session and, where it matters, a proposal
  carrying the concrete command (e.g. `progress.append` kind `report` on the focus block).
  `cond` is a tiny expression language (numbers, identifiers, `> >= < <= == !=`, `&& || !`,
  parentheses; no property access or calls, parsed at config load, unknown identifiers read 0)
  over the session's counters plus derived `progress`, `turns_since_progress`,
  `threads_opened_open`, `user_turns_on_focus_without_thread`. Checks are **edge-triggered**: one
  fires when its condition turns true and not again until it was false, so each state change is
  reported once. Cap rejections are counted by the daemon from real errors; a call to the same
  command after a rejection counts as a retry.
- **Report capture**: the adapter hands every subagent's final message to Core, which stores it as
  a `progress` entry of kind `report` on the worker's block, verbatim up to a cap, with the rest
  spilled to the store. Mechanical, unconditional, no LLM.
- **Nudge**: counter thresholds in a tree-less project → one-line notice, once per session. With
  no Hafiz project at all the plugin takes a cheap path: it returns four tiny hooks, keeps the
  counters in memory and, when a threshold trips, appends the line to the session's next system
  prompt (`system.transform`), once. No daemon, config change or proxy is ever started.
- **Drafters** (opt-in, default off): at `request_done` (digest draft from the progress log) and at
  `thread.park` without a gist (gist draft). Event-triggered, cheap model, output is a proposal or a
  pre-filled argument the agent must submit, never a direct write.
- **Review queue**: `hafiz review` (CLI) and `proposal.list` (MCP) show pending proposals;
  non-blocking by design — `auto` statuses proceed, the queue is for the user's later pass.
- **Events**: `ViewChanged{session, hash}`, `DeltaAvailable{session}`, `Notice{session}`,
  `ProposalAdded`, `CondensationDue{session}`. The adapter subscribes.
- **Cost instrumentation**: per session and project — view re-emits, tokens per rebuild, delta
  tokens, cache read/write ratio, condensations and their token cost. All plain session counters
  (`view_emits`, `view_tokens`, `delta_tokens`, `condensations`, `condense_tokens_in/out`,
  `wire_*`); the embedded proxy reads `usage` off every managed response (OpenAI
  `prompt_tokens_details.cached_tokens`, Anthropic `cache_*_input_tokens`; JSON bodies and the
  final SSE usage event, nothing buffered). `hafiz status` prints the table. The "cheaper than
  summarization" thesis is measured, not asserted.

---

## 8. Configuration

Layered: built-in → user (`~/.hafiz/config/`) → project (store `config/`). Files: `hafiz.yaml`
(backend, window sizes per model, `confirm_done`, LLM provider for condenser/drafters), `roles.yaml`,
`views.yaml`, `zooms.yaml`, `kinds.yaml`, `schemas/`, `policies.yaml` (status guards, epoch
minor paths, caps soft zone), `compliance.yaml`, `nudge.yaml`, `tail.yaml`, `rules/` (per-role
Markdown the adapter installs as agent prompts).

```yaml
roles:
  manager:  { view: default, focus_policy: all_active,
              tools: [context.*, block.*, tree.list, edge.*, doc.patch:plan, decision.record,
                      thread.*, progress.append, focus.set, proposal.*],
              rules: rules/manager.md }
  designer: { view: designer, focus_policy: all_active,
              tools: [context.*, block.read, tree.list, block.create, doc.write:design,
                      doc.patch:design, edge.*, decision.record, thread.*],
              rules: rules/designer.md }
  planner:  { view: default, focus_policy: all_active,
              tools: [context.*, block.read, tree.list, block.create, doc.write:plan,
                      doc.patch:plan, thread.*], rules: rules/planner.md }
  worker:   { view: worker, focus_policy: spawned_block,
              tools: [context.*, block.read, step.set, progress.append, thread.open, thread.park,
                      doc.write:digest, block.request_done], rules: rules/worker.md }
```

A role is data: view, focus policy, allowlist, rules. Adding `reviewer` is a config entry.

| Concern | Config | Code extension point |
|---|---|---|
| roles, views, zooms, kinds, schemas, guards, compliance, nudge, tail | ✔ | relation attribute providers, section format validators, guard predicates |
| rendering style | — | `Renderer` |
| storage / tokens / LLM | select by name | `StorageBackend`, `Tokenizer`, `LLMProvider` |

---

## 9. SPI: storage

```ts
interface StorageBackend {
  open(projectId); tx<T>(fn): Promise<T>            // journaled; atomic across files
  getBlock/putBlock(cas)/listBlocks; getDoc/putDoc(cas)
  appendLog(block, log, entry); readLog(block, log, {since?|last?})
  edges…; project…; sessions(): SessionStore; proposals(): ProposalStore; audit(): AuditLog
  history(block, type): Commit[]                     // backed by git in storage-fs
}
interface Tokenizer   { count(text, model?) }        // estimator + stated margin
interface LLMProvider { complete(prompt, {model: 'cheap'|'default', maxTokens}) }
```

**`storage-fs` (default)** — human-readable files, **git-backed**, **journaled**:

```
~/.hafiz/projects/<id>/            # a git repository
  project.yaml
  blocks/<block-id>/
    block.yaml  design.md  plan.md  digest.md
    steps.jsonl  progress.jsonl  decisions.jsonl  threads/<id>.md
  config/
  .journal/                        # write-ahead journal: a command's file set is staged here,
                                   # fsynced, then applied; recovery replays or discards on open
  state/                           # sessions, counters, proposals, audit — committed, not exported
```

- Every major write commits with author `<role>/<agent> <session@hafiz>`; minor writes are batched
  into a commit every `N` seconds or on the next major write. `history()` is `git log`;
  rollback is `hafiz revert <block> <type> <commit>` (which is itself a new, attributed write).
  A remote can be configured for backup; team sharing (deferred) builds on this.
- Markdown headings map 1:1 to schema sections; hand edits are detected (dirty tree) and surfaced.
- **Location**: data in home, pointer in repo. `<repo>/.hafiz/project.yaml` carries the project id
  and an **origin fingerprint** (remote URL hash + creator). A daemon that finds a pointer with no
  matching store **refuses to auto-create** and tells the user to `hafiz init --adopt` (new store,
  new id) or import. No permission prompts arise from the location: agents never touch the files;
  all writes are MCP tool calls the adapter allowlists.

`storage-sqlite` implements the same interface and passes the same conformance suite: one SQLite
file (`<store>/hafiz.sqlite`, `node:sqlite`), rows per entity, append-only `logs`/`audit` tables, and a
`versions` table with one row per doc write that backs `history` and `docAt`. A transaction
commits as one SQLite transaction. `storage.backend` (`fs` | `sqlite`) selects it.

---

## 10. Process model

One daemon per project, started on demand by the first client, holding the store lock; MCP shims,
CLI and the Kilo plugin talk to it over a local socket (JSON-RPC). The socket is created mode
`0600` in the user's runtime dir; clients present their capability token. Idle shutdown; durable
state in the backend. Appends never conflict; replaces use CAS; commands are journaled.

---

## 11. Gateways

### 11.1 MCP (`hafiz mcp --role <r>`)

One server process per role per host agent; exposes that role's tools only (**role = server
instance**, universal across hosts). The tool catalogue (names, descriptions, zod schemas) lives in
core (`TOOL_SPECS`) and is shared with host-native tool registrations such as Kilo's (§12.1). Tool descriptions carry protocol hints. Elicitation is used for
`confirm_done: ask` where supported; otherwise `needs_confirmation`. Resources: `hafiz://block/<id>`;
prompts: one per role. Session: token from env → session; project from roots/cwd.

### 11.2 CLI (`hafiz …`)

`init [--adopt] [--backend]`, `tree`, `show <block> [--zoom]`, `history <block> [type]`, `revert`, `status`,
`review`, `checkpoint`, `direct` (record a standing decision), `focus`, `explain`, `doctor`
(wiring, drift: files under a done block changed since `done_at.commit`), `migrate`,
`export/import`, `install <host>`, `daemon`.

---

## 12. Host adapters

### 12.1 Kilo (v1) — one TypeScript plugin

| Job | Mechanism |
|---|---|
| Install (`config` hook, stable) | `agent.<role>` definitions (prompt = role rules + `rules/common.md`, `permission` `hafiz_*: deny` + allow for exactly the role's tools, `permission.task` for who may delegate); default-role tool permissions for non-Hafiz agents; slash commands; `permission.edit/read` deny for the store; **`compaction.auto: false`** for managed sessions |
| Tools (`tool` hook, stable) | **plugin-native** `hafiz_<command>` tools generated from the shared catalogue (`TOOL_SPECS` in core, also used by the MCP gateway; execution shared via `runTool`). Each call resolves the calling Kilo session → Hafiz session (`session.open` with the Kilo id; role from the agent, parent from `parentID`, spawned block from `hafiz:block=<id>`) and dispatches with that session's token, so attribution and focus are per session. `host.kilo.tools: mcp` keeps the per-role MCP servers instead |
| Default roles | `host.kilo.default_role` (default `manager`) manages non-role primary agents (`build`, `plan`, custom) as that role: tools, session, and the role's rules + view injected by the shaper. `host.kilo.default_subagent_role` (default `worker`) does the same for non-role subagents (`general`, `explore`) **only** when spawned with a `hafiz:block=` marker; otherwise they are unmanaged. `none` disables either |
| Observe (`event`, stable) | `session.created/idle`, `tool.execute.after`, `file.edited` → counters; subagent final text → report capture; spawn → mint token, set computed focus |
| **RequestShaper** | interface with two implementations, selected by config/feature detection: **`transform-hooks`** (`chat.system.transform` for envelope+floor, `chat.messages.transform` for unfiled/tail/delta — preferred while these experimental hooks exist) and **`embedded-proxy`** (stable: `config` points the provider `baseURL` at a proxy inside the plugin process; Kilo attaches auth, the proxy forwards it; same shaping logic on the wire). Both are in-process; no external network path |
| Condensation | triggered by Core's `CondensationDue`; `LLMProvider` may route through Kilo's own provider config |
| `done` confirmation | `needs_confirmation` (no elicitation on Kilo); default `auto` makes it rare |

### 12.2 Claude Code / Codex — specified, not built

**Append-only mode**: envelope injected at `SessionStart` (all sources incl. after compaction) and
re-appended on hash change via `UserPromptSubmit`; highest hash wins; host compaction stays on and
its summary serves as unfiled context; tail trimming limited to shaping results on entry; Codex
role isolation advisory within a session. Guarantees that do **not** hold in this mode: stable
prefix, retro-stubbing, condensation ownership. See HOST-MATRIX §3.

---

## 13. Repository layout

```
packages/ core · storage-fs · storage-sqlite · gateway-mcp · cli · host-kilo · (host-claude-code, host-codex: later)
packages/core/config/default/ roles.yaml views.yaml zooms.yaml kinds.yaml schemas/ policies.yaml compliance.yaml nudge.yaml tail.yaml rules/
docs/ ARCHITECTURE.md DESIGN-NOTES.md HOST-MATRIX.md
```

---

## 14. Testing

- View engine golden tests (determinism is a tested property); `context.explain` output in fixtures.
- Backend conformance suite (fs and sqlite), including crash-mid-command recovery via the journal.
- **Protocol compliance harness**: scripted multi-agent tasks on Kilo with each role; measures
  decisions recorded / progress appended / threads parked / reports captured per role, *before*
  tuning. This number decides how much the condenser and drafters must carry.
- Shaper tests: recorded Kilo requests → byte-identical prefix when the hash is unchanged; exact
  replacement when it changed; tail/delta/unfiled placement.
- Cost tests: re-emits/hour and cache ratio on a simulated 8-worker hour.

---

## 15. Open decisions

1. Implementation language — TypeScript/Node recommended (Kilo plugins are TS; one runtime for
   daemon, shims, CLI, plugin).
2. Daemon transport — Unix socket JSON-RPC (recommended) vs localhost HTTP.
3. Condenser model routing — Hafiz's own `LLMProvider` config vs reuse of the host's provider.
