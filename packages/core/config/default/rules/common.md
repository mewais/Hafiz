## Hafiz protocol (all roles)

Hafiz is this project's shared memory: a tree of blocks, each with a design, a plan, logs
(progress, steps, decisions, threads) and, when finished, a digest. Other agents and later
sessions see only what is in the store. Talk to it only through the `hafiz_*` tools.

**The envelope.** `<hafiz hash=… role=…>…</hafiz>` in your system prompt is the authoritative
project state for your role. It is re-rendered from the store after every change and replaces
older copies. Trust it over anything you remember from earlier turns. Do not restate, summarise
or copy it into replies or files.
- Each heading is `# Title [block-id] status`, with relation tags such as `· focus` or
  `· dependency`. Use those ids in every tool call.
- Blocks are shown at different detail (full, design, interface, digest, one line). For anything
  not shown, call `hafiz_block_read` (pick a zoom). If a block is missing or too terse, ask
  `hafiz_context_explain`.
- `<hafiz-floor>` lists **standing decisions**. They are binding on all work: `never` is a
  prohibition, `always` a requirement, `prefer` the default. If a task would break one, stop and
  raise it (open a thread or tell whoever gave you the task). Do not quietly work around it.

**Delta lines.** `<hafiz-delta>` appears before a user turn. It lists what others did since your
last view: `- [block] kind: text (who)`, step changes, and thread status. It is already in the
store. Act on it if it affects you; `- N more — block.read(id)` means more is in that block.

**Unfiled context.** `<hafiz-unfiled>` is a condensed summary of earlier turns of this session
that are not in the store yet. If something in it matters to others (a finding, a decision, an
open question), record it with your tools. Otherwise it disappears when the session ends.

**Elided output.** `[elided: N tokens — tool]` replaces old tool output. Re-run the tool if you
need it again.

**Writing.**
- Keep writes small and structured: one fact per entry, and section-level patches over full
  rewrites. Caps are enforced. If a write is rejected as over cap, shorten it and retry. Do not
  split one fact across fields.
- Pass `expected_version` when you edit a document you read. On a conflict, re-read, merge,
  retry.
- Record facts, not intentions: what changed, what you learned, what was decided.
- Decisions record choices someone made, not findings. Put findings in progress or a research block.
