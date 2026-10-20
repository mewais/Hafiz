# Hafiz — Implementation Plan

Vertical slices, each ending in something runnable and tested. Order is chosen so that the riskiest
assumptions (deterministic view engine, embedded-proxy shaping on Kilo, protocol compliance rate)
are tested as early as possible. Companion to [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Status

| Milestone | State |
|---|---|
| M0 Scaffold | done: monorepo, biome, vitest, default config as fixtures |
| M1 Core + storage-fs | done: domain, schemas, commands, journaled git-backed fs store, conformance suite |
| M2 View engine + tail | done: Relate/Policy/Render/Degrade/Floor/Hash, tail policy, goldens |
| M3 Daemon + MCP | done: daemon, sessions, role-filtered MCP, CLI status/review/direct/focus/explain |
| M4 Kilo adapter | done: plugin (config/event/tool hooks), embedded-proxy and transform-hooks shapers, rules |
| M5 Compliance, condenser, cost | done: compliance checks, nudge, LLM providers, condenser, drafters, cost table |
| M6 Harness | built: scripted S/M/L tasks and metrics; baseline numbers need real models (see its README) |
| M7 Hardening + packaging | done: storage-sqlite, migrate, doctor (incl. drift), export/import, install kilo, two npm packages, README |
| Auto-start + worktrees | done: pointer in git's common dir (worktrees share a project), `hafiz_track_project` with a mid-session switch to managed mode, brownfield onboarding |

## Stack (proposed defaults — change before M0 if you disagree)

| Concern | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript, Node ≥ 20, ESM | Kilo plugins are TS; one runtime for daemon, shims, CLI, plugin |
| Monorepo | pnpm workspaces + `tsc -b` project references | cheap, standard |
| Tests | vitest; golden files under `__golden__/` | fast, snapshot-friendly |
| Schemas / validation | zod for API payloads; YAML schema sets parsed into zod at load | runtime validation with good error text for agents |
| Config | `yaml` package; layered merge with provenance (for `explain`) | |
| MCP | `@modelcontextprotocol/sdk` (server); same package's client in tests | |
| Daemon RPC | JSON-RPC 2.0 over Unix socket, newline-delimited; `vscode-jsonrpc` | small, battle-tested |
| Git | shell out via `simple-git` | git is present wherever agents run; avoids reimplementing |
| Tokenizer | `gpt-tokenizer` as estimator for all vendors + 15% soft zone | good enough; model-exact counting is an SPI impl later |
| LLM provider | Anthropic + OpenAI-compatible clients behind `LLMProvider` | condenser/drafters only |
| Kilo plugin | `@kilocode/plugin`; `engines.opencode` range pinned | |
| Lint/format | biome | one tool |

## Package graph

```
core ──────────────┐
storage-fs ───────►│ (depends on core types)
storage-sqlite ───►│ (M7)
gateway-mcp ──────►│
cli ──────────────►│
host-kilo ────────►│ (+ gateway-mcp client, + RequestShaper)
config/default      (data; loaded by core)
```

## Milestones

### M0 — Scaffold (small)
- Monorepo, packages stubbed, biome, vitest, CI (lint + typecheck + test), `config/default/` with the
  YAML from ARCHITECTURE §6/§8 checked in as the first fixtures.
- **Exit:** `pnpm test` green on an empty suite; CI runs.

### M1 — Core domain + storage-fs
- Entities, status machine with guard predicates, major/minor write classification, CAS, append logs,
  step events, decisions with `standing`, threads, proposals, audit entries.
- Schema sets + `kinds.yaml`: parsing, validation, caps with soft zone, agent-readable errors.
- Commands/queries from §5 (except `context.*`), authz by role allowlist + session token.
- `storage-fs`: journal (stage → fsync → apply → recover on open), git init/commit with attributed
  authors, `history`, dirty-tree detection, pointer file + fingerprint + refuse-to-auto-create.
- **Backend conformance suite** (runs against any `StorageBackend`), including kill-mid-command tests.
- CLI: `init`, `tree`, `show`, `history`, `revert`, `migrate` (no-op v1), `doctor` (wiring only).
- **Exit:** scripted scenario test — init, create a 3-level tree with edges, parallel appends from
  two "sessions", reopen a done block, revert a design — passes; git log shows attributed commits.
- **Proves:** the model holds together; atomicity and history work.

### M2 — View engine + tail policy (pure, heavily tested)
- Relate (focus set, `dep_distance`, max-zoom aggregation), Policy, Render, Degrade, Floor, Hash.
- `context.for`, `context.explain`, `context.delta`, `block.read(zoom)`.
- Tail policy as pure functions over a host-neutral `Conversation` model: stubbing rule, delta
  placement, unfiled slot, "never touch" invariants. Condensation *trigger* logic (no LLM yet).
- Golden tests: fixture trees × focus sets × roles × budgets → exact text; degrade sequences;
  explain output; byte-identical hash when nothing relevant changed.
- **Exit:** goldens for the worked example in DESIGN-NOTES (auth/billing/invoices/payments) and for a
  60-block synthetic tree under three budgets.
- **Proves:** determinism, bounded views, that the policy YAML is expressive enough (B1).
- Can run in parallel with M1 once core types exist.

### M3 — Daemon + MCP gateway
- Daemon lifecycle (on-demand start, lock, idle exit), socket RPC, session store keyed by host
  session id, tokens, counters API, event bus, pending-notice queue.
- `hafiz mcp --role r`: role-filtered tools, descriptions with protocol hints, `needs_confirmation`,
  elicitation when the client advertises it, resources, prompts.
- CLI gains `status`, `focus`, `explain`, `review` (list/accept/reject), `direct`.
- **Exit:** integration test with an MCP client: manager + two worker sessions drive the M1
  scenario over MCP; `context.for` returns per-role views; a worker calling `set_status:done` is
  refused and `request_done` enqueues; reconnect re-attaches the session.
- **Proves:** the protocol works end to end without any host.

### M4 — Kilo adapter, embedded-proxy shaper first
- Plugin skeleton: `config` hook registers role servers, agents (prompts from `rules/`, permissions),
  slash commands, store deny rules, `compaction.auto: false`; `event` hook feeds counters; report
  capture from subagent final text; token minting + computed focus at spawn.
- `RequestShaper` interface; **`embedded-proxy`** implementation: in-process HTTP server; wire
  adapters for Anthropic Messages and OpenAI Chat Completions (Responses if a used provider needs
  it); passthrough streaming; shaping = system envelope + floor, unfiled slot, tail stubbing, delta;
  byte-identical passthrough tests when hash unchanged.
- **`transform-hooks`** implementation behind a flag (`chat.system.transform`,
  `chat.messages.transform`, `session.compacting` as a safety net if compaction is ever re-enabled).
- Rules files for the four roles (first real versions).
- **Exit:** manual end-to-end on a toy project in Kilo CLI: manager spawns a designer and two
  workers; views differ per role; a done block collapses to digest; a standing decision survives
  everything; `hafiz status` shows re-emits and cache ratio.
- **Proves:** the whole thesis on a real host; which shaper is viable today.

### M5 — Compliance, nudge, condenser, cost
- Compliance checks from `compliance.yaml` → notices + proposals; nudge; long-unthreaded-discussion
  notice.
- `LLMProvider` + condenser: rolling unfiled summary + proposals; `/hafiz checkpoint`; budget
  accounting; proposals into the review queue.
- Cost instrumentation surfaced in `hafiz status`.
- **Exit:** a scripted 200-turn session on the toy project never triggers host compaction, the
  unfiled summary stays under its cap, proposals appear for deliberately omitted protocol calls.

### M6 — Compliance harness and tuning
- Scripted task set (small / medium / large trees; each role) run on Kilo with real models;
  measures per role: decisions recorded, progress appended, threads parked, reports captured, cap
  rejections, retries. Baseline first, then tune rules/tool descriptions/notices; re-measure.
- Drafters (digest at `request_done`, gist at `park`) implemented, opt-in, measured.
- **Status:** harness built (`packages/harness`: S/M/L tasks, runner, per-role metrics, `compare`;
  verified end to end on real Kilo against the mock LLM). Baseline and tuned numbers need real
  models: run on a developer machine per `packages/harness/README.md`.
- **Exit:** a published baseline number per role and a tuned number; decision on drafters' default.

### M7 — Hardening and packaging
- `storage-sqlite` through the conformance suite; `migrate` with a real schema change; `doctor`
  drift check via `done_at.commit`; export/import; Kilo marketplace entry; install docs.
- (Optional) Claude Code / Codex append-only adapters per HOST-MATRIX §3.
- **Status:** done, except the marketplace listing and the optional adapters (not started).
  - `storage-sqlite` on `node:sqlite` (no native dependency), selected by `hafiz.yaml
    storage.backend: sqlite` through one factory (`createBackend` in gateway-mcp, used by the CLI
    and the daemon); `hafiz init|import --backend sqlite` writes that setting into `<store>/config`.
  - Schema sets carry `schema_version`; the project pins it; `migrations/<from>-<to>.yaml`
    (`rename_section`, `add_section`, `drop_section`, `map_kind`); `hafiz migrate [--dry-run]` is
    all-or-nothing and attributed to the user. Config layers (`~/.hafiz/config`, `<store>/config`)
    are now actually loaded by the CLI, daemon and plugin.
  - `hafiz doctor`, `export`, `import`, `install|uninstall kilo` (`jsonc-parser` edits).
  - Packaging: `hafiz` and `@hafiz/kilo-plugin` are esbuild bundles (`scripts/bundle.mjs`, run by
    `pnpm build`); the other `@hafiz/*` packages stay private workspace packages. Not published.

## Dogfooding

From M3 onward, Hafiz's own development is tracked in Hafiz: this plan becomes the block tree
(root = Hafiz; children = packages; sub-blocks = milestones' items), with the architecture doc's
sections as root design. It is the cheapest realistic test of the brownfield story and of the
medium-scale case.

## Resolved inputs

- Stack as above ("clean and light" was the only requirement). Node floor: 22.
- Providers in Kilo are mixed per session (Anthropic, OpenAI, DeepSeek, Kimi, other open-source).
  M4 builds OpenAI Chat Completions (covers most open-source gateways) and Anthropic Messages
  first, OpenAI Responses next.

## Testing without model access

The development environment has npm and general HTTPS but no model API keys. By design this
costs little:

- **M0–M3** use no model: fixtures, golden files, a scripted MCP client.
- **M4** installs the real Kilo CLI and `@kilocode/plugin` and points a custom OpenAI-compatible
  provider at a **mock LLM server** (scripted responses incl. tool calls, streaming). This exercises
  the real plugin end to end — hooks, shaping, MCP, report capture — with no external calls.
  Recorded real requests (captured on a developer machine) become wire-adapter goldens.
- **M5** tests the condenser against a deterministic fake `LLMProvider`.
- **Real-model runs** (M4 smoke, M6 compliance numbers) run on a developer machine with real
  providers, or from the dev environment if a Kilo / OpenRouter key is provided as a secret.

## Risks and where they are retired

| Risk | Retired by |
|---|---|
| Policy YAML not expressive enough | M2 goldens on a large synthetic tree |
| Embedded proxy breaks streaming/caching for some provider | M4 passthrough tests + real run |
| Experimental Kilo hooks change | `RequestShaper` abstraction; proxy is the stable path |
| Agents ignore the protocol | M5 checks + capture; M6 measured, tuned, drafters if needed |
| Condenser cost creeps | bounded by construction; M5 scripted session measures it |
| Store corruption | M1 journal + kill tests; git history as recovery |
