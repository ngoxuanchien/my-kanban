# Start a linked task only when all its prerequisites are done

Date: 2026-11-04

## Why

Task 4e3a9 waited on two tasks (5e706 and 09cb7). It auto-started as soon as 5e706 moved to Done while 09cb7 was still In Progress. `getLinkedBacklogTaskIdsReadyAfterTaskTrashed` (`src/core/task-board-mutations.ts:208-232`) marks every backlog task linked to the finished task as ready without checking its other prerequisites. With several prerequisites, a dependent task can start on a base that lacks work it needs, and conflicts follow.

## Goal

A backlog task becomes ready only when **every** task it waits on is in Done (trash) after the move. Same rule for `getReadyLinkedTaskIdsForTaskInTrash` (`:418`). The web UI delegates to these core functions (`web-ui/src/state/board-state.ts:421-429`), so one fix covers UI and CLI.

## Non-goals

- No change to link direction rules, the review-passed / In Progress rule at `:217`, or how dependencies are stored.
- No new UI.

## Decided

- A prerequisite counts as finished only when its card is in the `trash` column; a prerequisite id that no longer exists on the board (deleted task) counts as finished.
- The task being moved counts as finished (it is moving to trash in the same call).

## Acceptance

- New tests in the existing task-board-mutations tests: A waits on B and C; trashing B from Review → `readyTaskIds` is empty; then trashing C from Review → `[A]`. Single prerequisite behaviour unchanged. Deleted second prerequisite → ready. Same cases for `getReadyLinkedTaskIdsForTaskInTrash`.
- `npm run typecheck`, `npm run lint`, `npm run test:fast` pass.
