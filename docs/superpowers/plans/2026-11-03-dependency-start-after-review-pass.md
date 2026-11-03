# Plan: start linked tasks after a passed review from In Progress

Spec: `docs/superpowers/specs/2026-11-03-dependency-start-after-review-pass-design.md`

One Kanban task.

## Task 1
1. `src/core/task-board-mutations.ts` (`getLinkedBacklogTaskIdsReadyAfterTaskTrashed` ~208, `trashTaskAndGetReadyLinkedTaskIds` ~417): accept a "review passed" flag that also allows `in_progress`.
2. Thread the flag from `task done --review-passed` (`src/commands/task.ts` ~1225) through `completeTaskToDone` (`src/workspace/complete-task-to-done.ts`).
3. Investigate why a handed-off task with session `awaiting_review` stays in `in_progress` (start from `src/server/hand-off-task.ts` and wherever the runtime moves a card to `review` when a session goes to `awaiting_review`); fix if small.
4. Tests per the spec.
Acceptance: `npm run typecheck && npm run lint && npm run test:fast`.
