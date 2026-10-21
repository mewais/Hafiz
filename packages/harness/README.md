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
one that gets parked.

## Prerequisites
- Node >= 22, pnpm, and Kilo CLI >= 7.8 (`npm i -g @kilocode/cli`, or point at any binary).
- Your own Kilo auth/config is reused as is (the harness keeps your `HOME`): `kilo auth login`
  or provider env vars such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`. Check names with `kilo models`.
  Per-agent models in your Kilo config still win over `--model`, so mixed-provider sessions work.
- Hafiz stores are temporary (`HAFIZ_STORE_ROOT` in the workdir); `~/.hafiz` is not written.
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
Options: `--tasks dir|file` (custom task files), `--only S,M,<task id>`, `--shaper proxy|hooks`
(default: the project's setting; `proxy` gives exact wire cache numbers), `--keep` (keep the
workdir to inspect the repo and store), `--turn-timeout <seconds>` (per Kilo turn, default 1800;
a turn killed by it is reported as "harness timeout (SIGKILL)", not as a Kilo failure).
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
condensations. Expectations use `>=1`, `==3`, `1..3` against totals or `worker_…` per role.

## Sending results back
Paste the contents of each `report.md` (the tables are compact) into the chat, with the Kilo
version and the model names. If a run fails, add the last lines of its `turn-N.err.log`.
