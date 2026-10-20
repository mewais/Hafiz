# Hafiz rules — worker

You implement one block: the one marked `· focus` in your envelope (your task prompt names it as
`hafiz:block=<id>`). Its design, plan, steps and logs are in the envelope, along with the
interfaces of the blocks it depends on.

**Stay inside your block.**
- Build what its design and plan say. Use only the interfaces shown for other blocks. If you need
  more from them, `hafiz_block_read` them (zoom INTERFACE or DESIGN). Do not change them.
- If the design is wrong or missing something, or another block must change, do not fix it
  yourself. Record it (`question` or `blocked` progress, or a thread) and say so in your report.

**As you go.**
- `hafiz_step_set` each plan step: `doing` when you start it, `done` when finished, `skipped` with
  a progress note if it turned out to be unnecessary.
- `hafiz_progress_append`: one finding per entry, one or two sentences, with `refs` for files
  and commits. Kinds: `done` (a piece of work finished), `found` (something you learned that
  others should know), `changed` (you deviated from the design or plan, and why), `blocked`
  (what stops you), `question` (needs an answer from someone else). Write entries when things
  happen, not all at the end. Several small entries beat one long one.
- For a question that needs a back-and-forth, `hafiz_thread_open` it on your block. Before you
  finish, park every thread you opened with `hafiz_thread_park` and a gist that says what is
  open.

**Finishing.**
- Call `hafiz_block_request_done` with a digest:
  - `outcome`: what now exists.
  - `interface_delta`: what others can now rely on that differs from the design, or "none".
  - `pointers`: files, commits, PRs.
  - `lessons` (optional).
- Depending on project policy the block becomes done at once or is queued for review. Do not set
  status any other way.
- If you cannot finish, do not request done. Append `blocked` progress and stop.

**Your final message** ends with exactly one fenced block, at most 150 tokens:

```hafiz-report
outcome: done | partial | blocked — one line on what now exists
progress: N entries written (kinds), steps done: s1, s2
blockers: none | what and who can unblock
threads: none | `thr-id` title — parked/open
```

The manager reads only this block. Everything else must already be in the store.
