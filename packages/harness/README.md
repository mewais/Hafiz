# @hafiz/harness — compliance harness (M6)

Scripted tasks run on real Kilo against a generated toy repo; per-role metrics and
expected-vs-actual scores come out of the Hafiz store. Private, not published.

## What a run does
Per task and repeat: temp workdir with the toy shop repo, `hafiz init`, optional seeded block tree,
a harness-owned daemon, then one `kilo run --agent … -m provider/model` per user turn (turns 2+
continue the same Kilo session). Afterwards it reads the store (logs, threads, proposals, audit)
and the session counters. Tasks (`tasks/*.yaml`): **S** one-off fix, no tree (expect zero Hafiz
writes, no nudge); **M** feature → block + 4 children + a worker each; **L** seeded 3-level tree,
designer + planner + 3 parallel workers, a side discussion that becomes a standing decision and
one that gets parked. **M gated** (`m-feature-gated`) is the feature with design and plan reviews
set to `gate`, run as designer, then planner, then workers across three turns.

## Review step and policies
A turn may name a review for the moment after it. Before the next turn the runner resolves the
pending design and plan review proposals only (not done requests, drafts or compliance) as the `user` role, through the daemon (`reviewList`, `reviewAccept`,
`reviewReject`), as the review overlay or `hafiz review` would:
```yaml
policies:                  # optional: written to <store>/config/policies.yaml before the daemon starts
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
$H run --mock                                       # pipeline check, scripted LLM, no keys
$H run --model anthropic/claude-sonnet-4-5 --only S # cheap first real run
# baseline across models, 3 repeats each (S, M, L; L is the expensive one)
$H run --repeat 3 --out results/baseline \
  --model anthropic/claude-sonnet-4-5 --model openai/gpt-5 --model deepseek/deepseek-chat
# after tuning rules/descriptions (pnpm build), re-run into results/tuned, then:
$H compare results/baseline/<a>/report.json results/tuned/<a>/report.json
```
Options: `--isolate` (see below), `--tasks dir|file` (custom task files), `--only S,M,<task id>`, `--shaper proxy|hooks`
(default: the project's setting; `proxy` gives exact wire cache numbers), `--keep` (keep the
workdir to inspect the repo and store), `--turn-timeout <seconds>` (hard wall-clock limit per Kilo turn from spawn, default 1800; a task may set
`turn_timeout: <seconds>` to override it; a turn killed by it is reported as "harness timeout (SIGKILL)", not as a Kilo failure).
`--isolate` (default off) runs Kilo with an empty private config dir (`XDG_CONFIG_HOME`), so
only the harness plugin and the agents it generates are loaded; your own plugins, agents and
providers do not leak in (auth in `XDG_DATA_HOME` is kept, so built-in providers still work; a
custom provider defined only in your Kilo config is not available). Use it to measure Hafiz alone,
for comparable numbers across machines. Leave it off to measure your own setup with Hafiz.
Exit code 1 means a turn failed or an expectation missed.

## Results
`<out>/<model>-<timestamp>/` holds `report.md` (one table per task: roles as columns, means over
repeats, then the expectation table), `report.json` (what `compare` reads), and per run
`<task>-<n>/result.json` plus `turn-N.out.jsonl` / `turn-N.err.log` (Kilo's raw output) and
`delegations.jsonl`: every `task` call of a managed session as the model wrote it (`role`, `agent`,
`block`, first 200 characters of the prompt, and the `error` text when the mechanical checks
refused it). The plugin writes it when the harness sets `HAFIZ_DELEGATION_LOG`; the refused ones
are listed under the task table in `report.md`.
Metrics: `files_written` is read from the task repo's git state after the run (files changed or
added against the seed commit, whoever wrote them; names in `result.json`), `files_written_managed`
is the Hafiz session counter (workers running unmanaged do not count). `spawns_rejected` counts
`task` calls vetoed by the checks; `tracked` is 1 when an agent created the Hafiz project.
Other metrics: decisions (standing), progress per worker, step events, threads opened/parked,
done requests (+ with digest), reports captured, cap rejections and retries, compliance notices,
proposals by source, protocol / all tool calls, view re-emits, tokens per view, cache read ratio,
condensations. Expectations use `>=1`, `<=2`, `==3`, `1..3` against totals or `worker_…` per role.
Defaults are deliberately loose where models legitimately vary: S allows `hafiz_writes <=2` (the
rules ask for one `changed` entry); M and L allow `cap_rejections <=2`, L `threads_opened <=2`;
M's prompt states a decision ("Discounts apply before tax, always.") so `manager_decisions >=1`.
`subagents_spawned` counts each `task` call once and `delegations.jsonl` logs it once.

## Sending results back
Paste the contents of each `report.md` (the tables are compact) into the chat, with the Kilo
version and the model names. If a run fails, add the last lines of its `turn-N.err.log`.
