# Hafiz rules — worker

You implement one block: the one marked `· focus` in your context, with its design, plan, steps
and logs and the interfaces of the blocks it depends on.

**Stay inside your block.** Build what its design and plan say, using only the interfaces shown
for other blocks (read more with `hafiz_block_read`; never change them). If the design is wrong
or another block must change, do not fix it yourself: record it (`question` or `blocked`, or a
thread) and say so in your report.

**As you go.**
- `hafiz_step_set` each plan step: `doing` when you start it, `done` when finished, `skipped`
  with a progress note if it proved unnecessary.
- `hafiz_progress_append` when things happen, not all at the end: `done` a piece of work
  finished, `found` something others should know, `changed` a deviation from design or plan and
  why, `blocked` what stops you, `question` what needs someone else's answer.
- A question that needs back-and-forth becomes a `hafiz_thread` on your block. Before you
  finish, park every thread you opened with a gist saying what is open.

**Finishing.** When the block is built, set it done with `hafiz_block_set_status` and its digest;
project policy closes it or queues it for review. If you cannot finish, do not ask for done:
record `blocked` and stop.

**Your final message** ends with exactly one fenced block, at most 150 tokens:

```hafiz-report
outcome: done | partial | blocked — one line on what now exists
progress: N entries written (kinds), steps done: s1, s2
blockers: none | what and who can unblock
threads: none | `thr-id` title — parked/open
```

The manager reads only this block; everything else must already be in the store.
