# @hafiz/harness — compliance harness (M6)

Scripted tasks run on real Kilo against a generated toy repo; per-role metrics and
expected-vs-actual scores come out of the Hafiz store. Private, not published.

## What a run does
Per task and repeat: temp workdir with the toy shop repo, then one `kilo run --agent … -m
provider/model` per user turn (turns 2+ continue the same Kilo session). The harness does not
stand in for the plugin or the manager. By default the repo is **untracked**: nothing Hafiz exists
before Kilo starts, and the manager calls `hafiz_track_project` when work turns multi-step (the
brownfield repo is then `onboarding: pending`, exactly as after `hafiz init`). A task with
`setup.tracked: true` (S, L) starts as a tracked project: the real `hafiz init`, and for a seed a
short-lived daemon that creates the tree and is closed before Kilo starts. In both cases the
Kilo plugin finds or starts the project daemon itself (project pointer, socket under
`XDG_RUNTIME_DIR`, `hafiz daemon`), with the run's env (`HAFIZ_HOME`, `HAFIZ_STORE_ROOT`,
`XDG_RUNTIME_DIR`, `HAFIZ_DELEGATION_LOG`). Between turns the runner is a user of that daemon
(the review step). At the end it stops the daemon (SIGTERM to the pid in the store lock, which
flushes the store; SIGKILL after 10 s; also with `--keep`, which keeps only the workdir),
then opens the store directly to read logs, threads, proposals, audit and the session counters.
The runner finds the socket the way the plugin and CLI do (`socketPathFor(pointer id)`, the
function exported by `@hafiz/gateway-mcp`), and sets `daemon.idle_shutdown_seconds` to a day in
the run's private `$HAFIZ_HOME/config/hafiz.yaml` so the daemon outlives the last turn. Tasks (`tasks/*.yaml`): **S** one-off fix, no tree (expect zero Hafiz
writes, no nudge); **M** feature → block + 4 children + a worker each; **L** seeded 3-level tree,
designer + planner + 3 workers, a side discussion that becomes a standing decision and
one that gets parked. **M** and **M gated** start untracked. **M gated** (`m-feature-gated`) is a
two-part feature (percentage coupon codes; applying them in the cart total) with design and plan
reviews set to `gate`, run as designer, then planner, then workers across three turns.
**L's seed** is what a designer and a planner would have left on the brownfield toy repo: real
designs that match the code (`Cart`, `Orders`, `Inventory` and money exist; the three leaves are
missing work: `Cart.lineTotals()`/`subtotalCents()`, `priceCart(cart): PricedCart` with no rules
yet, `Orders.placeOrder` recording a priced order), `provides`/`consumes` from which the edges
derive, and a plan for Cart totals only. The root has no design, so onboarding is pending: turn 1
is satisfiable by exactly the onboarding designer, one designer refinement of Checkout, one
planner for Pricing and Orders, and three workers. Seed nodes take `design:` and `plan:` as
section maps, validated by Core like any write.

## Tiers and fail-fast
`--tier smoke` (the default) runs the tasks that declare `tiers: [smoke, …]`: S, M gated and L,
once each, with fail-fast on. `--tier full` runs every task, `--repeat` times, with fail-fast off.
`--only` picks from every task unless `--tier` is also given. Fail-fast (`--fail-fast`,
`--no-fail-fast`) checks a task's `expect_after` after each turn but the last, against the store
as it is then (read from a copy, the plugin's daemon keeps running); a miss stops the task there,
skips its remaining turns and repeats, and reports the turn and the checks that missed:
```yaml
expect_after:                      # turn -> checks decidable by then (same syntax as expect)
  1: { tracked: "==1", designer_sessions: ">=1" }
  2: { "planner_sessions or planner_docs_written": ">=1" }   # `a or b`: either holds
```

## Review step and policies
A turn may name a review for the moment after it. Before the next turn the runner resolves the
pending design and plan review proposals only (not done requests, drafts or compliance) as the `user` role, through the project's daemon (the plugin's; one is started on demand if none answers) (`reviewList`, `reviewAccept`,
`reviewReject`), as the review overlay or `hafiz review` would:
```yaml
setup:
  tracked: false           # default; true = `hafiz init` (+ `seed:`) before Kilo starts
  broken_money: false      # default; true seeds the formatMoney bug + failing test (only s-small-fix); else the suite is green
policies:                  # optional: written to $HAFIZ_HOME/config/policies.yaml before Kilo starts
  review: { design: gate, plan: gate }
turns:
  - prompt: Add order discounts ...
    review: accept         # accept | reject | none (default)
  - prompt: Design approved; plan and implement it.
    review: reject
    note: Cover coupon stacking.   # reaches the manager with the rejection
  - prompt: Plans approved; proceed.
```
`result.json` records what was resolved: `reviews: [{id, kind, block, action}]`. `policies:` is a
partial `policies.yaml` merged over the defaults for that run only. Expectations are scored once,
at the end.

## Prerequisites
- Node >= 22, pnpm, and Kilo CLI >= 7.8 (`npm i -g @kilocode/cli`, or point at any binary).
- Your own Kilo auth/config is reused as is (the harness keeps your `HOME`): `kilo auth login`
  or provider env vars such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Check names with `kilo models`.
  Per-agent models in your Kilo config still win over `--model`, so mixed-provider sessions work.
- Hafiz stores are temporary (`HAFIZ_STORE_ROOT` in the workdir); `HAFIZ_HOME` is a private dir in the
  workdir, so `~/.hafiz` is neither read nor written (a task runs under the built-in defaults plus
  its own `policies:`).
- Runs use `kilo run --auto` (permissions auto-approved) inside a throwaway repo copy.

## Commands
```
pnpm install && pnpm build
export HAFIZ_KILO_BIN=$(command -v kilo)            # or pass --kilo-bin
H="node packages/harness/dist/bin.js"

$H tasks                                            # list the task set
$H run --mock --tier full                           # pipeline check, scripted LLM, no keys
$H run --model anthropic/claude-sonnet-4-5          # smoke: S, M gated, L once, fail-fast
$H run --model anthropic/claude-sonnet-4-5 --only S # cheapest real run
# baseline across models, 3 repeats each (every task; L is the expensive one)
$H run --tier full --repeat 3 --out results/baseline \
  --model anthropic/claude-sonnet-4-5 --model openai/gpt-5 --model deepseek/deepseek-chat
# after tuning rules/descriptions (pnpm build), re-run into results/tuned, then:
$H compare results/baseline/<a>/report.json results/tuned/<a>/report.json
```
Options: `--tier smoke|full`, `--fail-fast`/`--no-fail-fast` (above), `--isolate` (see below), `--tasks dir|file` (custom task files), `--only S,M,<task id>`, `--shaper proxy|hooks`
(default: the project's setting; `proxy` gives exact wire cache numbers), `--keep` (keep the
workdir to inspect the repo and store), `--turn-timeout <seconds>` (hard wall-clock limit per Kilo turn from spawn, default 1800; a task may set
`turn_timeout: <seconds>` to override it; a turn killed by it is reported as "harness timeout (SIGKILL)", not as a Kilo failure).
`--isolate` (default off) runs Kilo with a private config dir (`XDG_CONFIG_HOME`) that holds only
the `provider` section and the `model` / `small_model` keys of your own Kilo config
(`config.json`, `opencode.json[c]`, `kilo.json[c]` in `$XDG_CONFIG_HOME/kilo` or `~/.config/kilo`,
merged in that order; `{env:…}` references are copied as written, never resolved). So the
harness plugin and the agents it generates are loaded, your custom providers keep working, and
your own agents, plugins, permissions and instructions do not leak in (auth in `XDG_DATA_HOME` is
kept). Use it to measure Hafiz alone, for comparable numbers across machines. Leave it off to
measure your own setup with Hafiz.
Exit code 1 means a turn failed or an expectation missed.

## Results
`<out>/<model>-<timestamp>/` holds `report.md` (one table per task: roles as columns, means over
repeats, then the expectation table), `report.json` (what `compare` reads), and per run
`<task>-<n>/result.json` plus `turn-N.out.jsonl` / `turn-N.err.log` (Kilo's raw output) and
`delegations.jsonl`: every `task` call of a managed session as the model wrote it (`role`, `agent`,
`block`, first 200 characters of the prompt, and the `error` text when the mechanical checks
refused it). The plugin writes it when the harness sets `HAFIZ_DELEGATION_LOG`; the refused ones
are listed under the task table in `report.md`. `rejections.jsonl` (`HAFIZ_REJECTION_LOG`, same
pattern): every Hafiz write refused for size, with the role, block, command and each section
over its cap (`design.interface`, `plan.steps`, `progress`, `thread.gist`, …) with its measured
size and cap; `report.md` tables them per section (count, roles, median and largest overage), so
a run tells whether a cap or the writer should move. `sessions/<role>-<id>.json`: each
subagent's transcript as `kilo export` gives it (the manager's own turns are in
`turn-N.out.jsonl`).
Metrics: `files_written` is read from the task repo's git state after the run (files changed or
added against the seed commit, whoever wrote them; names in `result.json`), `files_written_managed`
is the Hafiz session counter (workers running unmanaged do not count). `spawns_rejected` counts
`task` calls vetoed by the checks; `tracked` is 1 when an agent created the Hafiz project (M and M gated expect `==1`; S and L start
tracked, so it is 0).
Other metrics: decisions (standing), progress per worker, step events, threads opened/parked,
done requests (+ with digest), reports captured, cap rejections and retries, compliance notices,
proposals by source, protocol / all tool calls, view re-emits, tokens per view, cache read ratio,
condensations. Expectations use `>=1`, `<=2`, `==3`, `1..3` against totals or `worker_…` per
role (a role with no session counts 0), and `a or b`. They assert that the pipeline happened and
nothing pathological did, not one shape of it: a manager that runs a tester and a coder per block
has twice the worker sessions, one that re-spawns the designer once has one more designer
session. So sessions and done requests are lower bounds, designer sessions `<=4` (L and M gated
`1..4`: onboarding is part of the job on the brownfield repo), threads and `cap_rejections <=2`
upper bounds, and `spawns_rejected ==0`. S stays strict: it is about not over-tracking
(`hafiz_writes <=2`, the rules ask for one `changed` entry; no project, no block). M's prompt
states a decision ("Discounts apply before tax, always.") so `manager_decisions >=1`.
`subagents_spawned` counts each `task` call once and `delegations.jsonl` logs it once.

## Sending results back
Paste the contents of each `report.md` (the tables are compact) into the chat, with the Kilo
version and the model names. If a run fails, add the last lines of its `turn-N.err.log`.
