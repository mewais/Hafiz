# Hafiz

Hafiz is shared project memory for coding agents. It keeps a tree of blocks (designs, plans,
decisions, progress, threads) outside the conversation and gives every agent a small,
role-shaped view of it, so long sessions and parallel subagents stay consistent. Everything is
written through a few structured tools; humans can read, review and revert it as plain files in
git or a single SQLite file.

## Install

Requires Node 22.5 or newer.

```sh
npm i -g hafiz-context-manager   # the `hafiz` CLI, daemon and MCP gateway (one file, no dependencies)
hafiz install kilo               # add the plugin to your global Kilo config (or --project for this repo)
```

From a local clone instead: `pnpm install && pnpm build`, `npm i -g ./packages/hafiz`, then either
`hafiz install kilo` (installs the npm plugin `hafiz-kilo`) or point Kilo's `plugin` array at the
clone's `packages/kilo-plugin` directory; `hafiz install kilo` and `hafiz doctor` recognise that
path and will not add a second entry.

That is all: tracking starts automatically (below).

`hafiz install kilo` edits `~/.config/kilo/kilo.jsonc` in place (with `--project`, the repo's
`kilo.jsonc` or `.kilo/kilo.jsonc` instead), keeping your comments,
and adds `hafiz-kilo` to its `plugin` array; it adds the same package to `tui.jsonc` next
to it for the TUI panel. It is idempotent; `hafiz uninstall kilo` removes both. Kilo loads the
plugin on its next start.

## Start a project

Nothing to do. In a git repo Hafiz does not track yet, Kilo's primary agents get one extra tool,
`hafiz_track_project`, and nothing else from Hafiz (no daemon, no view, a one-line nudge at
most). When a task turns multi-step or will spawn subagents, the agent calls it on its own (never
for one-off questions or small edits) and tells you in one line: "Tracking this repo with Hafiz
as `<name>`". The same Kilo session continues managed from its next step: the project view, the
manager's rules and the Hafiz tools, no restart. The TUI panel is always there: it
reads `Hafiz · untracked` until that call completes, then shows the tree at once (driven by Kilo's
events, no polling; tracking started outside Kilo, e.g. `hafiz init` in a terminal, shows at the
next TUI start). Only what Kilo reads once at startup waits for its next start: shaping runs
through the transform hooks rather than the embedded proxy, Kilo's own auto-compaction stays as it
was, a condenser routed through Kilo is available only if the user-level config asked for it, and
with `host.kilo.tools: mcp` the Hafiz tools wait too.

If the repo already has code (commits and at least `onboarding.min_source_files` tracked source
files, default 5), the project starts with onboarding pending: the manager first has the designer
describe the codebase as it is in the root design, importing what current work touches and
stubbing what it only calls. An empty repo starts fresh and the manager designs with you.

To start one by hand:

```sh
cd my-repo
hafiz init "My Project"   # creates the store and the pointer .git/hafiz/project.yaml
hafiz doctor              # checks the wiring; run it whenever something looks off
```

`init` needs a git repository. Add `--backend sqlite` to keep the store in one SQLite file
instead of a git repository. The pointer lives in git's common dir
(`$(git rev-parse --git-common-dir)/hafiz/project.yaml`), so the main checkout and all its
`git worktree`s share one project, one store and one daemon; each session still records the HEAD
of its own worktree. The pointer is not committed: a separate clone is a separate project
(linking clones by remote is not supported yet). Repos set up by older versions have
`.hafiz/project.yaml` in the working tree; it still works, and `hafiz migrate-pointer` moves it.

## Using it in Kilo

- The plugin adds four agents: **manager**, **designer**, **planner**, **worker**. Plain Kilo
  agents (`build`, `plan`, ...) act as the manager by default (`host.kilo.default_role`), so you
  can just start talking; the agent starts tracking on its own once the work is multi-step.
- The manager delegates one block per subagent: Kilo's `task` tool takes a required `block`
  (a block id, or `none` for a helper outside Hafiz). Hafiz refuses a spawn that does not fit the
  block (a worker before there is a plan, anyone on a done block) or that copies the block into
  the prompt. A worker's final message ends with a `hafiz-report` block; Hafiz stores the whole
  reply in the block's progress log and hands the manager only that block.
- Anything agents want to change that needs a human (a finished design or plan, marking a block
  done, a proposed digest, a missing protocol call) lands in the **review queue**: `hafiz review`
  lists it, `hafiz review --show ID` prints the design or plan under review,
  `hafiz review --accept ID` or `--reject ID --note "why"` resolves it. Which events file a
  proposal, and which hold the block until you accept, is the review policy (below).
- `hafiz status` shows the epoch, live sessions, token cost and re-emits, and pending
  proposals. In Kilo the same is `/hafiz-status`; `/hafiz-checkpoint` records unrecorded work.
- Record a rule for every agent with `hafiz direct "Never touch the billing schema." --kind never`.
- Look around: `hafiz tree`, `hafiz show [<block>]`, `hafiz context --role worker --focus <block>`,
  `hafiz explain <block>`, `hafiz history [<block>] design`, `hafiz revert <block> design <commit>`.
  `<block>` may be omitted for `show` and `history` (the root block is used), and anywhere it is
  accepted it can be a block id, a unique id prefix or a case-insensitive exact title.

## Agent tools

Agents reach Hafiz through twelve tools; each role sees only its own, narrowed to what it may do
(`config/default/roles.yaml`). Their descriptions carry the mechanics; the rules in
`config/default/rules/` say when to use them.

| Tool | Does | Roles |
|---|---|---|
| `hafiz_block_read` | read a block at a zoom; no id: the tree; `explain`: why it shows as it does | all |
| `hafiz_block_create` | create a block, optionally with its design and plan | manager, designer, planner |
| `hafiz_block_edit` | rename, change kind or order, move | manager |
| `hafiz_block_set_status` | planned → active → done, blocked, dropped; a worker's `done` is a request the policy closes or queues | manager, worker (done only) |
| `hafiz_doc` | patch a design or plan (`replace` for a whole rewrite); an existing doc needs `expected_version` | manager (plan), designer (design), planner (plan) |
| `hafiz_step_set` | mark a plan step doing / done / skipped | worker |
| `hafiz_progress_append` | one finding on a block's progress log | manager, designer (found, question), worker |
| `hafiz_decision_record` | a choice made and why; `standing` makes it binding on every agent | manager, designer |
| `hafiz_thread` | open, append, park (with a gist), resume, resolve a discussion | manager, designer, planner, worker (open, park) |
| `hafiz_review` | list, accept or reject (with a note) proposals in the review queue; design and plan reviews only under `approver: manager` | manager |
| `hafiz_focus_set` | centre the context on chosen blocks | manager |
| `hafiz_track_project` | start tracking an untracked repo | primary agents, untracked repos only |

Dependencies between blocks are not a tool: a design's `interface.consumes` entries name their
providing block, and every design write keeps the block's `depends_on` edges in step with them.
The MCP gateway (`hafiz mcp --role <r>`) serves the same tools plus `hafiz_context_for`,
`hafiz_context_delta` and `hafiz_session_status` for hosts that do not inject the context.

## The Kilo TUI panel

In the Kilo TUI the session sidebar gets a **Hafiz** section: the project, this session's role
and the blocks it is on (`manager · on Checkout, Pricing`), the block tree (◆ root, ✓ done,
▶ active, ◐ active with children, ○ planned, ⧗ blocked, ✗ dropped; `3/5 steps`; `waits on user`;
`(review)` or `(rejected)` on a block a gated design or plan review holds; `●` on this session's
focus blocks), open questions on the focus blocks, the pending review items
(`review  design Orders · done Cart totals`) and the latest notices. Paths to focus and active
blocks are open, finished and planned subtrees are folded to `▸ Billing  +4 hidden`; click a row
to open or close it. Click the footer (`? legend · …`) for a legend of the glyphs. The prompt
shows a chip such as `◆ Payments · 2 pending`, and new review items and compliance notices pop up
as toasts.

`ctrl+x v` (or `/hafiz-review`, or a click on the review line) opens the **review overlay**: the
pending items (⏎ opens one: the doc at the version under review, with the sections changed since
the approved version marked, `d` for the previous version, and the block's decisions and open
questions), `a` accepts, `r` rejects with a note the manager sees, esc steps back. These are the
panel's only writes, made as the `user`; everything else it reads as a `viewer` session the
daemon refuses all writes for.

`/hafiz` (or `ctrl+x f`) opens a full-screen view with four tabs: **Tree** (↑↓ move, ⏎/→ open,
← close, `z` cycles the zoom of the selected block, `h` its doc history), **Review** (pending
proposals with what they would run; ⏎ opens one in the overlay), **Decisions** (standing rules
and recent decisions per block) and **Notices** (the session's Hafiz cost, then every notice).
Esc goes back.

## Condenser model

Without a condenser Kilo keeps its own compaction. To let Hafiz condense the conversation tail
with a cheap model, put this in `~/.hafiz/config/hafiz.yaml` (all projects) or
`<store>/config/hafiz.yaml` (one project). The recommended setting runs it through Kilo itself,
so it needs no extra key and its cost shows up in Kilo's usage for the session it condensed:

```yaml
llm:
  condenser:
    provider: kilo
    model: anthropic/claude-haiku-4-5    # any Kilo provider/model
  drafters: { enabled: true, provider: kilo, model: anthropic/claude-haiku-4-5 }  # optional
```

Or call a provider directly:

```yaml
llm:
  condenser:
    provider: openai-compatible        # or anthropic
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY    # the NAME of the variable holding the key
    model: google/gemini-2.5-flash
```

`hafiz doctor --online` sends a tiny request to check a direct provider is reachable.

## Review policy

`policies.yaml` (`~/.hafiz/config/` or `<store>/config/`) decides per event whether a proposal is
filed and whether it holds the next stage on that block until accepted. `off`: no proposal;
`queue`: a proposal, work goes on; `gate`: a proposal, and the block waits (siblings and
parents do not). The defaults are `queue`, except `done: gate` (as before), approved by the user; this
setting also gates designs:

```yaml
review:
  design: gate       # no planner or worker on the block until its design is accepted
  plan:   queue      # gate: no worker until the plan is accepted
  done:   gate       # default: done waits for confirmation / the manager
  drafts: queue      # condenser and drafter proposals (off | queue; never gate)
  approver: user     # user | manager: who accepts or rejects design and plan reviews
```

A design or plan is filed when the agent session that wrote it ends (or when a block is created
with one); a newer version replaces the pending proposal. Accepting pins the version on the
block; the next review says which sections changed since it. `hafiz doctor` warns about the
retired `hafiz.yaml confirm_done` (`ask` reads as `done: gate`, `auto` as `done: queue`).

## Where data lives

| What | Where |
|---|---|
| Store (blocks, docs, logs, git history) | `~/.hafiz/projects/<project-id>/` (`HAFIZ_STORE_ROOT` moves it) |
| SQLite store | `<store>/hafiz.sqlite` when `storage.backend: sqlite` |
| Repo pointer | `.git/hafiz/project.yaml` (git's common dir: shared by worktrees; legacy `<repo>/.hafiz/project.yaml`) |
| Config layers | built-in defaults, `~/.hafiz/config/`, `<store>/config/` (later wins) |
| Daemon socket | `$XDG_RUNTIME_DIR/hafiz/<project-id>.sock` (mode 0600) |

Agents never touch the store files; they go through tools. Hand edits to an fs store are
detected and reported by `hafiz doctor`.

## Maintenance

- `hafiz doctor`: pointer and store match, daemon health, hand edits, docs failing their
  schema, drift (files named in a done block's digest changed since it was marked done), Kilo
  wiring.
- `hafiz migrate [--dry-run]`: upgrade docs when the schema set's version moves
  (`migrations/<from>-<to>.yaml`: rename, add or drop a section, change a kind's schema).
- `hafiz export <file>` and `hafiz import <file> [--as-new]`: portable JSON snapshot (no
  sessions) between machines or backends. `--as-new` mints a new project id and fingerprint.

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Plan and status](docs/PLAN.md) ·
[Design notes](docs/DESIGN-NOTES.md) · [Host matrix](docs/HOST-MATRIX.md) ·
[Compliance harness](packages/harness/README.md)

Development: `pnpm install && pnpm lint && pnpm build && pnpm test`. `pnpm build` also bundles the
two publishable packages, `packages/hafiz` (`hafiz-context-manager`, bin `hafiz`) and
`packages/kilo-plugin` (`hafiz-kilo`). Releasing: `scripts/publish.sh` (dry run by default).

## Releasing

`pnpm release` (`scripts/publish.sh`) is a dry run; `pnpm release -- --yes` really publishes
`hafiz-context-manager`, then `hafiz-kilo` (pass a version to set both with `scripts/set-version.mjs`).

1. Publish once manually (`pnpm release -- --yes`): npm trusted publishing can only be configured
   on an existing package.
2. On npmjs.com, add a Trusted Publisher to both packages: GitHub Actions, repo `mewais/Hafiz`,
   workflow `release.yml`.
3. From then on, create a GitHub release with tag `vX.Y.Z` from `main`; `release.yml` sets the version
   from the tag, runs lint/build/test and publishes with provenance (`-rc.N` tags go to `next`).

Alternative to step 2: add an `NPM_TOKEN` repository secret (automation token); the workflow uses it.
