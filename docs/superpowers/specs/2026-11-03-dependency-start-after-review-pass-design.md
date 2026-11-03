# Start linked tasks after a passed review from In Progress

## Problem
On 2026-11-03, "Compact task list and task show" (73fa3) passed sidebar review and was moved to Done with `task done --review-passed`. Its linked backlog task 2b643 did not start; the link was removed and 2b643 stayed in Backlog.

Cause: linked backlog tasks only become ready when the finished task leaves the `review` column (`getLinkedBacklogTaskIdsReadyAfterTaskTrashed`, `src/core/task-board-mutations.ts:213`). 73fa3 was still in `in_progress` (session state `awaiting_review`) when the review ran. It had been handed off (antigravity hit its quota, the runtime moved it to codex). Why the card did not move to `review` is not yet known.

## Changes
1. **Ready rule:** a passed review counts like leaving Review. When `task done --review-passed` moves a task to Done from `in_progress`, linked backlog tasks become ready and auto-start exactly as from `review`. Without `--review-passed`, moving a task from `in_progress` to Done (cancel) still does not start dependents.
2. **Card column:** find why a task whose session reached `awaiting_review` stayed in `in_progress` after a handoff, and fix it so the card moves to `review` like any other finished task. If the cause cannot be found or the fix would be large, record findings in the task's last message and ship change 1 only.

## Tests
- `task done --review-passed` on an `in_progress` task with a linked backlog task: dependent is in `readyTaskIds` and is started.
- `task done` (no `--review-passed`) on an `in_progress` task: dependent stays in backlog (existing behavior).
- From `review`: unchanged.
- Change 2: a test reproducing the stuck card, if the cause is found.
