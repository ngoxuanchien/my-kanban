# Post the passing issue review at once

## Problem
GitHub issue sync holds a stored `pass` review until the card reaches Done
(`src/github/issue-sync.ts:293`), so the posted review can carry the base commit.
In PR mode the card waits in Review until the PR merges, and the issue shows no
review the whole time. The sidebar reviewer filled that gap by posting a review
comment by hand; when Done arrived, Kanban posted its stored copy too and the
issue got two reviews (task 598ff, issue #2, 2026-11-05).

## Decision
- Post a stored `pass` review on the next reconcile, the same way a `fail` review
  is posted. It has no `**Commit:**` line.
- Posting a `pass` review no longer sets `doneCommented`. At Done the runtime posts
  the short Done comment (`formatDoneComment`) with the base commit, then closes
  the issue. Result on the issue: review comment, then Done comment with commit.
- The sidebar prompt says the runtime posts the review at once, the commit goes
  in the Done comment, and the reviewer never posts a review comment by hand.

## Not changed
- `formatIssueReview` keeps its optional `commit` parameter; sync stops passing it.
- Fail reviews, `postedReviewIds` bookkeeping, reverse sync, and close behavior.

## Rejected
- Dedupe by scanning existing issue comments: a hand-written comment has a
  different format, so it would not match, and it costs one extra `gh` call per sync.
