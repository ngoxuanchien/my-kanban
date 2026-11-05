# Plan: post the passing issue review at once

Spec: `docs/superpowers/specs/2026-11-05-post-pass-review-at-once-design.md`. One Kanban task.

## Task 1 — Issue sync posts pass reviews at once (difficulty 2)
Files:
- `src/github/issue-sync.ts`: in the `pendingReviews` loop (~line 291), drop the
  `pass && column !== "trash"` skip and the task-history commit lookup; call
  `formatIssueReview(review)`; stop setting `doneCommented` from a pass review.
- `src/prompts/append-system-prompt.ts`: line 428 drops "and the pass Commit from
  task history"; line 446 says the runtime posts the stored review at once, the Done
  comment carries the base commit, and never post a review comment by hand.
- `test/runtime/github/issue-sync.test.ts`: update the tests that expect a held
  pass (first test, "does not reuse an older commit", "posts a later failed round
  while an earlier approval waits for Done"); add one test: pass posted while in
  Review without `**Commit:**`, then at Done exactly one Done comment with
  `**Commit:** <sha>` and close.
- Prompt test file asserting line 446 text, if one exists.

Acceptance: the commands in `docs/agents/task-prompt-template.md`.
