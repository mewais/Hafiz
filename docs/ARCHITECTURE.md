# Hafiz — Architecture

Hafiz (حافظ, *the one who memorizes; the guardian*) is a work-state-aware context manager for
multi-agent coding sessions. It keeps a project's architecture, block designs, plans, status,
decisions and open threads in a structured store that agents maintain through a small, role-scoped
tool protocol, and it assembles each agent's context deterministically from that store — no
ambient LLM summarization.

This document is the architecture of the host-agnostic core plus the thin host adapters.
Design discussion and rationale that led here is summarized in [`docs/DESIGN-NOTES.md`](DESIGN-NOTES.md).

---

## 1. Principles (the things everything else is derived from)

1. **Status is global, focus is per-consumer.** A block is `done` for everyone; *what you are
   looking at* is yours. Context = a view over the tree parameterized by (focus, role, budget).
2. **Compaction is assembly, not summarization.** The context an agent sees is rebuilt from the
   store by rules. Anything worth keeping must have been written to the store by an agent.
3. **Layout changes only at events (epochs).** Between events the context is a stable prefix plus
   an append-only tail. This keeps prompt caches valid and keeps Hafiz cheap.
4. **Hafiz is canonical and private.** Designs/plans live *only* in Hafiz, outside the repo.
   Write access is enforced by the host's per-agent tool allowlists; Hafiz versions every write.
5. **No tree → zero cost.** A project without a tree gets nothing injected and nothing rewritten.
6. **Everything structured.** Every document is a schema'd set of sections with size caps.
   Structure is what makes rendering, degradation and digests mechanical.
7. **Config over code.** Roles, views, zoom levels, schemas, budgets, nudge thresholds are
   configuration. Code provides interfaces and defaults; swapping behavior is a config change.
8. **Nothing is lost, only demoted.** Overflow turns "in context" into "one `read` away".

---

## 2. Layered overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  HOST ADAPTERS         claude-code/        kilo/          codex/             │
│  thin, generated from role/view config; bridge host events → core sessions   │
├──────────────────────────────────────────────────────────────────────────────┤
│  GATEWAYS              mcp/               proxy/          cli/               │
│  protocol surfaces; translate wire formats → Core API; no business logic     │
├──────────────────────────────────────────────────────────────────────────────┤
│  CORE (one daemon per project)                                               │
│   Domain model ─ Schemas ─ Commands/Queries ─ Authorization                  │
│   View engine (policy → zoom → render → degrade) ─ Session tracker ─ Events  │
├──────────────────────────────────────────────────────────────────────────────┤
│  SPI (service provider interfaces)                                           │
│   StorageBackend · Tokenizer · Renderer · ConfigSource · Clock               │
│   impls: storage-fs (default) · storage-sqlite · …                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point down only. Core knows nothing about MCP, HTTP, Claude Code, Kilo
or Codex. Gateways know the Core API and one wire protocol each. Adapters know one host each and
the gateway(s) they wire up.

---

## 3. Core: domain model

All identifiers are stable, short, human-readable slugs with a random suffix (`billing-7f2a`).

### 3.1 Entities

| Entity | Fields (abridged) | Mutability |
|---|---|---|
| `Project` | id, name, root_block_id, config_overrides, epoch | epoch increments on structural events |
| `Block` | id, parent_id, title, kind, status, order, version, doc_versions{design,plan,digest} | CAS on `version` |
| `Edge` | from_block, to_block, kind (`depends_on` default; extensible) | add/remove |
| `Doc` | block_id, type (`design`\|`plan`\|`digest`\|…), version, sections{name→content} | CAS on `version`; validated against its schema |
| `ProgressEntry` | block_id, ts, session_id, role, kind (`done`\|`blocked`\|`found`\|`changed`\|`question`\|…), text, refs[] | append-only |
| `Decision` | id, block_id, ts, title, decision, rationale, supersedes?, by{session,role} | append-only (supersede, never edit) |
| `Directive` | id, block_id, kind (`never`\|`always`\|`prefer`), text, rationale?, status (`active`\|`retired`), by, ts | append-only; retire, never edit; scoped to the block's subtree |
| `Thread` | id, block_id, title, gist, status (`open`\|`parked`\|`resolved`), entries[] | append-only entries; status transitions |
| `Session` | id, project_id, host, role, focus{block_ids[], order?}, counters, last_epoch_seen | ephemeral; per gateway connection |

`kind` on `Block` is a free string (`component`, `feature`, `research`, `doc`, …). Hafiz attaches no
semantics to it; schemas and views *may* match on it.

**Directives vs. decisions.** A decision records *what was chosen* and why; a directive is a standing
*imperative* the user (or manager on the user's behalf) has issued: "never commit generated files",
"always use the result type". Root directives are project-wide; a block's directives apply to its
subtree. They are part of the view **floor**: rendered verbatim for the focus and all its ancestors
at every zoom, never degraded. Each is capped (~40 tokens) and a per-block total cap triggers a
"consolidate directives" notice rather than silent growth. Host rules files (`CLAUDE.md`,
`AGENTS.md`) remain the place for static repo conventions; directives are what is learned mid-work
and travel with the Hafiz store across hosts.

### 3.2 Status machine

```
planned ──▶ active ◀──▶ blocked
   │          │
   │          ▼
   │        done
   ▼
dropped  ◀── (any)
```

Transition guards are config (`policies.status`), defaults:

- `→ done` requires: a `digest` doc supplied in the same command (or already present); no `open`
  threads on the block (must be `parked` or `resolved`); every child is `done` or `dropped`;
  confirmation per `confirm_done: ask | auto`.
- `→ active` on a block whose parent is `planned` auto-activates the parent (configurable).
- `→ dropped` requires a reason (stored as a `Decision` with `kind: drop`).

Guards are a list of named predicates; adding a guard is adding a config entry that references a
registered predicate (code) with parameters.

### 3.3 Epochs

- `project.epoch` increments on **major writes**: block create/drop/move, any block status change
  (`done` included), design/plan content changes, decision recorded, directive recorded/retired,
  edge change.
- It does **not** increment on **minor writes**: progress entries, thread entries, and plan step
  status ticks (`plan.steps[].status`). These are frequent, the consumer who cares learns of them
  from its own tail (a worker's report, its own tool result), and bumping the epoch for them would
  rebuild every consumer's prefix and churn prompt caches. The rendered view simply reflects their
  current state at the next epoch. The minor-path list is config (`policies.epoch.minor_paths`).
- `session.focus_epoch` increments on focus change for that session only.
- A rendered view carries `(project.epoch, session.focus_epoch)`. Gateways re-emit the context
  block only when either changed; otherwise the prefix is byte-identical.

---

## 4. Core: schemas (structured documents)

A **schema set** is a directory of YAML files, one per doc type. It is pluggable: `config.schema_set`
selects it; a project may pin a set and version. The default set:

```yaml
# schemas/design.yaml
type: design
sections:
  - name: purpose      required: true   cap: 150    format: prose
  - name: scope        required: true   cap: 200    format: list        # in / out
  - name: interface    required: true   cap: 600    format: structured  # see below
  - name: constraints  required: false  cap: 200    format: list
  - name: rationale    required: false  cap: 300    format: prose
  - name: references   required: false  cap: 100    format: refs        # external pointers only
caps_unit: tokens
on_cap_exceeded: reject        # warn | reject
```

```yaml
# schemas/plan.yaml
type: plan
sections:
  - name: steps        required: true  cap: 800  format: steps   # [{id,title,status,notes?}]
  - name: acceptance   required: true  cap: 200  format: list
  - name: risks        required: false cap: 200  format: list
```

```yaml
# schemas/digest.yaml
type: digest
sections:
  - name: outcome          required: true  cap: 200  format: prose
  - name: interface_delta  required: true  cap: 200  format: list   # "none" allowed
  - name: pointers         required: true  cap: 150  format: refs   # files, commits, PRs
  - name: lessons          required: false cap: 150  format: list
```

`format: structured` sections (e.g. `interface`) have a sub-schema (`provides[]`, `consumes[]`,
`contracts[]` with name/type/notes). `format: steps` is what makes plan progress mechanical.

Progress entries, decisions and threads are *log* schemas with a fixed small shape (see 3.1) and
per-entry caps.

**Validation** happens in Core on every write: required sections, formats, caps. Caps are measured
with the configured `Tokenizer`. Reject messages are designed for agents: they state the cap, the
measured size, and the remedy ("split into child blocks" / "move detail to progress notes").

---

## 5. Core: commands, queries, authorization

The Core API is the single internal contract. Every gateway maps onto it 1:1.

### 5.1 Commands (writes)

| Command | Semantics |
|---|---|
| `project.init(name, root_design?)` | create project + root block |
| `block.create(parent, title, kind?, order?, design?, plan?)` | may create with initial docs atomically |
| `block.update(id, {title, kind, order}, expected_version)` | CAS |
| `block.move(id, new_parent, expected_version)` | CAS; epoch |
| `block.set_status(id, status, {digest?, reason?, confirmed?}, expected_version)` | runs status guards; may return `needs_confirmation` |
| `edge.add(from, to, kind?)` / `edge.remove(...)` | epoch |
| `doc.write(block, type, sections, expected_version)` | full replace; validate; CAS; epoch |
| `doc.patch(block, type, {section: content}, expected_version)` | section-level; same guarantees |
| `progress.append(block, entry)` | append-only; no epoch |
| `decision.record(block, decision)` | append-only; epoch |
| `directive.record(block, kind, text, rationale?)` / `directive.retire(id)` | append-only; epoch; manager/user only by default |
| `thread.open/park/resume/resolve(...)` | `park` requires `gist`; `resume` returns gist+entries |
| `focus.set(session, block_ids, order?)` | session-scoped; focus_epoch |

Stale `expected_version` → `Conflict{current}` with the current content so the agent can re-read
and retry. All commands are atomic; multi-entity commands run in one backend transaction.

### 5.2 Queries (reads)

| Query | Semantics |
|---|---|
| `context.for(session \| {focus, role}, budget?)` | → `{text, manifest, epoch}`; see §6 |
| `block.read(id, zoom)` | one block at an explicit zoom |
| `tree.list(root?, depth?, filter?)` | ids/titles/status; cheap |
| `thread.list(block?, status?)` | |
| `session.status(session)` | counters, epochs, nudge state |
| `project.export()` / `project.import()` | snapshot (sharing is out of scope for v1) |

### 5.3 Authorization

A `Role` is a config object (§8). Core receives `(session.role, command)` and checks the role's
allowlist. Allowlist entries can be command names or command+argument patterns
(`doc.write:design`, `block.set_status:done`). The host adapter additionally restricts which tools
exist at all (defense in depth: the host hides the tool, Core refuses it anyway).

---

## 6. Core: the view engine

`context.for` is a pipeline of four pluggable stages, each configured, each replaceable:

```
 tree + statuses + focus
        │
        ▼
 ┌─────────────┐   relation(block, focus) ∈ {root, focus, ancestor, descendant,
 │ 1. Relate   │   dependency, dependent, sibling, other}; plus status, kind, depth
 └─────────────┘
        │
        ▼
 ┌─────────────┐   first-matching rule in the view's `rules` assigns a zoom level
 │ 2. Policy   │   (and optional floor = "never degrade below")
 └─────────────┘
        │
        ▼
 ┌─────────────┐   zoom → ordered list of section selectors; Renderer emits text
 │ 3. Render   │   (default: Markdown with stable headings + block ids)
 └─────────────┘
        │
        ▼
 ┌─────────────┐   measure with Tokenizer; if over budget apply the view's ordered
 │ 4. Degrade  │   `degrade` steps until it fits; if still over → emit a one-line
 └─────────────┘   "focus too wide" notice (and still return the best-effort view)
        │
        ▼
 {text, manifest: [{block, zoom, tokens}], epoch, notices[]}
```

### 6.1 Zoom levels (config: `zooms.yaml`)

```yaml
zooms:
  FULL:      [block.header, design.*, plan.*, decisions[-5:], progress[-10:], threads.open, threads.parked.titles]
  DESIGN:    [block.header, design.*]
  INTERFACE: [block.header, design.interface]
  DIGEST:    [block.header, digest.*, design.interface]
  LINE:      [block.line]            # "- [active] billing-7f2a — Billing (2 children)"
  NONE:      []
floor:                               # rendered regardless of zoom, never degraded
  - { match: { relation: [root, focus, ancestor] }, sections: [directives.active] }
```

`floor` entries are appended to whatever zoom the policy chose; the degrade stage is not allowed to
touch them. This is where directives live.

Levels are an ordered list (for degradation to know what "one step down" means). Adding a level
is a config change; a view then references it.

### 6.2 View policy (config: `views.yaml`)

```yaml
views:
  default:
    budget: { share_of_window: 0.30, min_tokens: 1500, max_tokens: 24000 }
    tail:   { keep_turns: 12, tool_result_max_age_turns: 6, stub_elided_results: true }
    rules:                                           # first match wins
      - { match: { relation: root },                         zoom: DESIGN,    floor: DESIGN }
      - { match: { relation: focus },                        zoom: FULL }
      - { match: { relation: ancestor },                     zoom: DESIGN }
      - { match: { relation: dependency, status: done },     zoom: DIGEST }
      - { match: { relation: dependency },                   zoom: INTERFACE }
      - { match: { relation: descendant, status: active },   zoom: INTERFACE }
      - { match: { status: done },                           zoom: DIGEST }
      - { match: { status: dropped },                        zoom: NONE }
      - { match: { relation: sibling },                      zoom: LINE }
      - { default: LINE }
    degrade:                                         # applied in order until it fits
      - { match: { status: done, relation: other },          to: LINE }
      - { match: { relation: sibling },                      to: NONE }
      - { match: { relation: ancestor },                     to: INTERFACE }
      - { match: { relation: focus }, trim: { progress: 3, decisions: 2 } }
      - { match: { relation: focus }, to: DESIGN, order: focus_reverse }   # lowest-priority focus first
      - { match: { status: done },                           to: LINE }
  worker:
    extends: default
    budget: { share_of_window: 0.20 }
    rules_prepend:
      - { match: { relation: sibling, status: planned },     zoom: NONE }
```

`match` keys are the attributes stage 1 computed; adding a new attribute (e.g. `kind`) requires no
engine change beyond computing it.

### 6.3 Tail policy

The tail is not stored by Hafiz; it is the host's transcript. Hafiz only *decides* what the tail
should look like and hands that decision to whoever can act on it (proxy, or the host's compaction
via the adapter): keep the last `keep_turns` verbatim; stub tool results older than
`tool_result_max_age_turns` as `[elided: 4.2k tokens — <tool>]`; never stub user turns.

### 6.4 Output contract

The rendered context block is wrapped in a stable envelope so gateways can find and replace it:

```
<hafiz project="shop-3c1d" epoch="42" focus_epoch="7" role="manager">
# Architecture (root)
…
</hafiz>
```

The block is deterministic for a given `(store state, focus, role, budget, config)` — same inputs,
byte-identical output. That property is what makes caching work and makes the engine testable.

---

## 7. Core: session tracker, nudge, events

- **Sessions** are created by gateways (one per MCP connection / proxy client / hook session) and
  tagged with host, role, project (resolved from cwd), and an optional host session id so a hook
  session and its MCP connection can be unified.
- **Counters** (`turns`, `tool_calls`, `files_written`, `subagents_spawned`, `tokens_in`) are fed
  by adapters/proxy. Core never observes the host directly.
- **Nudge** (config: `nudge.yaml`): thresholds, a one-line template, `max_per_session`. Evaluated
  on every counter update for sessions whose project has no tree (or whose focus is empty while a
  tree exists, as a separate, softer rule). Result is a notice the gateway/adapter may inject.
- **Event bus**: Core emits `EpochChanged{project, epoch}`, `FocusChanged{session}`,
  `Notice{session, text}`, `ConfirmationRequested{session, command}`. Gateways subscribe. This is
  how the proxy knows to rebuild a prefix and how an adapter knows to steer compaction.
- **Pending notices queue** per session: hosts offer injection only at fixed moments (prompt
  submit, session start), so notices accumulate in Core and the next injection drains them.
- **Structured handback**: worker roles end their final message with a fenced `hafiz-report` block
  (outcome, progress written, blockers, open threads; capped). Adapters that can shape tool
  results pass only that block to the parent; others instruct the parent to read only that block.
  Protocol-level, not an adapter trick.

---

## 8. Configuration model

Configuration is layered: built-in defaults → user (`~/.hafiz/config/`) → project
(`~/.hafiz/projects/<id>/config/`). Each layer is a directory:

```
config/
  hafiz.yaml        # backend, schema_set, tokenizer, window sizes per model, confirm_done, …
  roles.yaml
  views.yaml
  zooms.yaml
  nudge.yaml
  policies.yaml     # status guards, caps behavior
  schemas/          # schema set (or a reference to a named built-in set)
  rules/            # per-role rules snippets (Markdown) that adapters install into hosts
```

### 8.1 Roles (`roles.yaml`)

```yaml
roles:
  manager:
    view: default
    tools: [context.for, block.read, tree.list, thread.list, session.status,
            block.create, block.update, block.move, block.set_status, edge.*,
            decision.record, directive.*, thread.*, progress.append, focus.set]
    rules: rules/manager.md
  designer:
    view: designer
    tools: [context.for, block.read, tree.list, doc.write:design, doc.patch:design,
            edge.*, decision.record, thread.*]
    rules: rules/designer.md
  planner:
    view: default
    tools: [context.for, block.read, tree.list, block.create, doc.write:plan, doc.patch:plan,
            thread.*]
    rules: rules/planner.md
  worker:
    view: worker
    tools: [context.for, block.read, progress.append, thread.open, thread.park, doc.patch:plan.steps]
    rules: rules/worker.md
```

A role is purely data: a view name, a tool allowlist, a rules snippet. Adding `reviewer` is a new
entry. Host adapters consume this to generate per-role agent definitions with the matching tool
restrictions.

### 8.2 What is code vs. config

| Concern | Config | Code (extension point) |
|---|---|---|
| Roles, allowlists | ✔ | — |
| View rules, degradation order, budgets | ✔ | `Relation` attribute providers |
| Zoom levels → sections | ✔ | — |
| Doc schemas, caps | ✔ | section `format` validators/renderers |
| Status guards | ✔ (compose) | guard predicates |
| Nudge thresholds/template | ✔ | counter providers (adapters) |
| Rendering style | — | `Renderer` |
| Storage | select by name | `StorageBackend` |
| Token counting | select by name | `Tokenizer` |

---

## 9. SPI: storage and friends

```ts
interface StorageBackend {
  open(projectId): Promise<void>
  tx<T>(fn: (t: Tx) => Promise<T>): Promise<T>        // serializable per project
  // entities
  getBlock(id): Block | null;  putBlock(b, expectedVersion): void;  listBlocks(filter): Block[]
  getDoc(block, type): Doc | null; putDoc(d, expectedVersion): void
  appendLog(block, log: 'progress'|'decisions'|'threads/<id>', entry): void
  readLog(block, log, {last?: number}): Entry[]
  getEdges(filter): Edge[]; putEdge(e): void; deleteEdge(e): void
  getProject(): Project; putProject(p): void
  // ephemeral
  sessions(): SessionStore                              // may be memory-only
}
interface Tokenizer { count(text: string, model?: string): number }
interface Renderer  { render(view: ResolvedView): string }
```

**`storage-fs` (default)** — plain files under `~/.hafiz/projects/<id>/`, human-readable:

```
project.yaml
blocks/<block-id>/
  block.yaml                 # metadata + versions
  design.md                  # YAML front matter (version) + "## section" headings per schema
  plan.md
  digest.md
  progress.jsonl
  decisions.jsonl
  directives.jsonl
  threads/<thread-id>.md
state/                       # sessions, counters — not part of export
```

**Location: data in home, pointer in repo.** Keeping the data inside the project (`<repo>/.hafiz/`,
gitignored) would give every git worktree and every clone its own store — fragmentation, which is
worse than either pure option — and would put the design docs inside every agent's writable tree.
So:

- Data lives in `~/.hafiz/projects/<id>/` (`storage-fs.root` is configurable; in-project storage
  remains possible, it is just not the default). Outside the workspace, Codex's default sandbox
  cannot write there; the Claude Code and Kilo adapters install a deny rule for the path.
- `<repo>/.hafiz/project.yaml` holds only the project id and optional config overrides. It is
  committed by default so clones and worktrees resolve to the same store; users may gitignore it.
- Resolution order for a project id: pointer file → hash of the git remote URL → hash of the
  repo root path. `hafiz init` writes the pointer.
- **No permission prompts follow from this.** Agents never write to the store directly; every
  write is an MCP tool call served by the daemon, an ordinary host-spawned process outside the
  host's filesystem permission model (and outside Codex's sandbox). Hosts prompt per *tool*, not
  per *path*, and each adapter installs the host's allow-all for Hafiz's tools at setup
  (Claude Code `permissions.allow: ["mcp__hafiz__*"]`, Codex
  `mcp_servers.hafiz.default_tools_approval_mode = "auto"`, Kilo `permission: {"hafiz_*": "allow"}`).
  An in-project store would be the prompt-prone option: files an agent can see in its tree invite
  direct `Read`/`Edit`, which either prompts or silently bypasses versioning and role enforcement.

Markdown headings map 1:1 to schema sections, so a human can read or hand-edit a design and Hafiz
re-validates on next load. Atomicity: write-to-temp + rename; a per-project lock file held by the
daemon. **`storage-sqlite`** is the second backend (same interface; one file; better for large
trees and for search later). Both ship with a conformance test suite run against the interface.

---

## 10. Concurrency and process model

- **One daemon per project**, started on demand by the first gateway that needs it, holding the
  project lock. All gateways (MCP shims, proxy, CLI, hook scripts) are thin clients speaking to it
  over a local socket (Unix socket / named pipe; JSON-RPC). This gives atomicity across hosts
  (Claude Code and Kilo open on the same project) for free.
- **Idle shutdown** after a configurable period; state is durable in the backend.
- Appends never conflict; replaces use CAS; commands are transactions. Parallel workers are the
  expected case, not the edge case.

---

## 11. Gateways

### 11.1 MCP server (`hafiz mcp --role <role> [--project <id>]`)

- One process per host agent connection; `--role` selects the tool subset exposed (from
  `roles.yaml`). The process is a shim to the daemon. **Role = server instance**: hosts register
  `hafiz-<role>` servers and restrict agents at server granularity, which every host supports;
  per-tool restriction is a bonus where available. The role is also declared to Core per session so
  authorization holds even when a host cannot hide tools per subagent (Codex).
- Tool names mirror Core commands (`hafiz_block_set_status`, …). Tool descriptions carry the
  protocol hints ("call before marking done…").
- `confirm_done: ask` uses **MCP elicitation** when the client supports it; otherwise
  `block.set_status` returns `needs_confirmation` with instructions to ask the user and retry with
  `confirmed: true`.
- MCP **resources**: `hafiz://block/<id>` (DESIGN zoom), `hafiz://context` (current view) — for
  hosts that surface resources. MCP **prompts**: one per role, carrying the role's rules snippet.
- Session: connection = session; project resolved from the client's cwd (`roots` if provided,
  else `--project`).

### 11.2 Proxy (`hafiz proxy --listen …`) — phase 2, optional

Host-agnostic realization of principle 2 for hosts that cannot rebuild context natively. Per the
host matrix, all three hosts can inject and re-inject after compaction natively and Kilo can
rewrite history, so the proxy is not load-bearing; it is the path to Kilo-grade tail control on
Claude Code and Codex and a fallback if a host's hooks regress.

- **Wire adapters**: Anthropic Messages (Claude Code); OpenAI Responses (Codex — Chat Completions
  was removed from Codex); OpenAI Chat Completions (Kilo's openai-compatible providers). Each maps
  to and from a common `Conversation` model (system, messages, tool calls/results, cache hints).
  Claude Code requires `anthropic-*` headers, `cache_control` and SSE pings forwarded untouched.
- **Rewriter**: locates (or inserts) the `<hafiz …>` envelope at the stable position (end of system
  / first user turn, with a cache breakpoint where the wire supports it). On `EpochChanged` or
  `FocusChanged` → replace envelope with a fresh `context.for`. Apply tail policy (stub old tool
  results). Otherwise **byte-for-byte passthrough** including streaming.
- **Session identity**: per listening port or per header (`X-Hafiz-Session`/`X-Hafiz-Role`) set
  by the adapter's launch config; fallback: project from a configured cwd mapping.
- **Counters**: the proxy is also the richest counter source (turns, tool calls, tokens).
- Invariants: never alters tool definitions; never alters the newest user turn; never touches a
  request for a project with no tree.

### 11.3 CLI (`hafiz …`)

`init`, `tree`, `show <block> [--zoom]`, `status`, `focus`, `export`/`import`, `daemon`,
`doctor` (host wiring check), `install <host>` (runs the adapter installer).

---

## 12. Host adapters

Each adapter does three things, all derived from config: **install** (register MCP servers, write
per-role agent/mode definitions with tool restrictions, install rules snippets), **observe**
(bridge host events into session counters), and **act** (inject the context block / steer
compaction where the host allows). Where the host offers nothing for observe/act, the proxy is
used for both.

The verified per-host capability matrix and the full adapter designs are in
[`docs/HOST-MATRIX.md`](HOST-MATRIX.md). The conclusions that shape all three adapters:

| | Claude Code | Codex | Kilo (current) |
|---|---|---|---|
| Packaging | plugin (hooks+MCP+agents+skills) + installer step | plugin (hooks+MCP+skills) + installer step | one TS plugin module |
| Inject view | `SessionStart` (incl. after compaction) + `UserPromptSubmit`, append-only | same | system-prompt transform, replaced in place |
| Tail control | shape results on entry (`updatedToolOutput`); no retro-stub | none in-band (`output_token_limit`) | full history transform (experimental) |
| Steer compaction | static CLAUDE.md section only; re-inject after | `compact_prompt`; re-inject after | replace compaction prompt |
| Role isolation | per-agent server allowlist | advisory within a session; profiles across | per-agent permission globs |
| `done` confirmation | elicitation | elicitation | `needs_confirmation` fallback |

Cross-host decisions (HOST-MATRIX §2): **role = MCP server instance** (`hafiz mcp --role r`);
**append-only injection with self-describing envelopes** where hosts cannot replace text, the
highest epoch being authoritative; **re-injection after compaction** as the keystone on Claude Code
and Codex; **structured handback** blocks from workers; **the proxy is optional (phase 2)** since
every host offers native injection and post-compaction re-injection, and Kilo offers native rewrite;
**installer writes user-level settings** that plugins cannot.

---

## 13. Repository layout

```
hafiz/
  packages/
    core/               domain, schemas, commands, queries, view engine, sessions, events, daemon
    storage-fs/         default backend
    storage-sqlite/     second backend (after core stabilizes)
    gateway-mcp/
    gateway-proxy/
    cli/
    host-claude-code/   host-kilo/   host-codex/
  config/default/       roles.yaml views.yaml zooms.yaml nudge.yaml policies.yaml schemas/ rules/
  docs/                 ARCHITECTURE.md DESIGN-NOTES.md HOST-MATRIX.md
```

---

## 14. Testing strategy (architecture-level)

- **View engine golden tests**: fixture trees + focus + budget → exact expected text. Determinism
  is a tested property.
- **Backend conformance suite** run against every `StorageBackend`.
- **Proxy wire tests**: recorded host requests in all three wire formats → passthrough is
  byte-identical when no epoch change; envelope replacement is exact when there is one.
- **Protocol tests**: status guards, CAS conflicts, cap rejections produce the specified agent-
  readable errors.

---

## 15. Open decisions

1. **Implementation language.** Recommendation: TypeScript/Node — first-class MCP SDK, single
   runtime for daemon + shims + hook scripts, `npx`-installable across all three hosts.
2. **Daemon transport**: Unix socket JSON-RPC (recommended) vs. localhost HTTP (simpler on
   Windows). Could support both behind one interface.
3. **Tokenizer**: model-specific counting vs. a single fast estimator with a safety margin
   (recommended for v1; caps and budgets are approximate by nature).
