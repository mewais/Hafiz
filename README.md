# Hafiz

Hafiz is shared project memory for coding agents. It keeps a tree of blocks (designs, plans,
decisions, progress, threads) outside the conversation and gives every agent a small,
role-shaped view of it, so long sessions and parallel subagents stay consistent. Everything is
written through a few structured tools; humans can read, review and revert it as plain files in
git or a single SQLite file.

## Install

Requires Node 22.5 or newer.

```sh
npm i -g hafiz            # the CLI, daemon and MCP gateway (one file, no dependencies)
hafiz install kilo        # add the plugin to this repo's Kilo config (or --global)
```

`hafiz install kilo` edits `kilo.jsonc` (or `.kilo/kilo.jsonc`) in place, keeping your comments,
and adds `@hafiz/kilo-plugin` to its `plugin` array. It is idempotent; `hafiz uninstall kilo`
removes it. Kilo loads the plugin on its next start.

## Start a project

```sh
cd my-repo
hafiz init "My Project"   # creates the store and the repo pointer .hafiz/project.yaml
hafiz doctor              # checks the wiring; run it whenever something looks off
```

`init` needs a git repository. Add `--backend sqlite` to keep the store in one SQLite file
instead of a git repository. Commit `.hafiz/project.yaml`: it is only a pointer (project id and
fingerprint), so teammates and fresh clones find, or are told to create, their own store.

## Using it in Kilo

- The plugin adds four agents: **manager**, **designer**, **planner**, **worker**. Plain Kilo
  agents (`build`, `plan`, ...) act as the manager by default (`host.kilo.default_role`), so you
  can just start talking; the manager offers to track the work once it is multi-step.
- The manager delegates one block per subagent. Every task prompt carries `hafiz:block=<id>`;
  without it a subagent is unmanaged. A worker's final message ends with a `hafiz-report` block
  that Hafiz captures into the block's progress log.
- Anything agents want to change that needs a human (marking a block done, a proposed digest,
  a missing protocol call) lands in the **review queue**: `hafiz review`, then
  `hafiz review --accept ID` or `--reject ID`.
- `hafiz status` shows the epoch, live sessions, token cost and re-emits, and pending
  proposals. In Kilo the same is `/hafiz-status`; `/hafiz-checkpoint` records unrecorded work.
- Record a rule for every agent with `hafiz direct "Never touch the billing schema." --kind never`.
- Look around: `hafiz tree`, `hafiz show <block>`, `hafiz context --role worker --focus <block>`,
  `hafiz explain <block>`, `hafiz history <block> design`, `hafiz revert <block> design <commit>`.

## Condenser model

Without a condenser Kilo keeps its own compaction. To let Hafiz condense the conversation tail
with a cheap model, put this in `~/.hafiz/config/hafiz.yaml` (all projects) or
`<store>/config/hafiz.yaml` (one project):

```yaml
llm:
  condenser:
    provider: openai-compatible        # or anthropic
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY    # the NAME of the variable holding the key
    model: google/gemini-2.5-flash
```

`hafiz doctor --online` sends a tiny request to check the provider is reachable.

## Where data lives

| What | Where |
|---|---|
| Store (blocks, docs, logs, git history) | `~/.hafiz/projects/<project-id>/` (`HAFIZ_STORE_ROOT` moves it) |
| SQLite store | `<store>/hafiz.sqlite` when `storage.backend: sqlite` |
| Repo pointer | `<repo>/.hafiz/project.yaml` |
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
two publishable packages, `packages/hafiz` (`hafiz`) and `packages/kilo-plugin`
(`@hafiz/kilo-plugin`).
