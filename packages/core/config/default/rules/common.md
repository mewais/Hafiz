## Hafiz (every role)

Hafiz is this project's shared memory: a tree of blocks, each with a design, a plan, logs and,
once finished, a digest. Other agents and later sessions know only what is in it; use the
`hafiz_*` tools.

- `<hafiz …>` in your system prompt is the project state for your role, re-rendered after every
  change. Trust it over earlier turns; never copy it out. Headings read
  `# Title [block-id] status · relation`: use those ids. `hafiz_block_read` shows more.
- `<hafiz-floor>`: standing decisions, binding on all work. `never` forbids, `always` requires,
  `prefer` is the default. If a task would break one, stop and raise it.
- `<hafiz-delta>`: what others did since your last view, already recorded. `<hafiz-notices>`
  are for you: act on them.
- `<hafiz-unfiled>`: earlier turns not yet recorded. Record what others need, or it is lost.
- `[elided: N tokens — tool]`: old tool output; re-run it if needed.

**Writing.** Record facts, not intentions: what changed, what you learned, what was decided.
One fact per entry; patch sections rather than rewrite. Caps are enforced: shorten a rejected
write and retry. A decision is a choice someone made, never a finding.
