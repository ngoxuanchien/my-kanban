# No changes expected (task flag)

One Kanban task, no separate plan.

## Problem

The empty-task nudge (`docs/superpowers/specs/2026-10-29-empty-task-nudge-design.md`) sends `[Kanban] No changes found in your worktree ... The task is not done.` to the task session when its turn ends with a clean worktree and no commits since the base ref (`src/server/sidebar-review-service.ts:466-492`). For research and spike tasks the deliverable is outside git (a local note in `contexte/`), so the nudge is wrong. On 2026-11-06 "Skill sets: spike per-CLI controls" (1c071) got the nudge, the agent filed a blocked report, and the sidebar never got a review wake-up.

## Change

- New optional card field `noChangesExpected?: boolean` (default absent = false).
- When `noChangesExpected === true`, the runtime skips the empty-worktree check and nudge entirely and goes straight to the review queue, as it does for a task with changes.
- CLI: `task create --no-changes-expected <true|false>` and `task update --no-changes-expected <true|false>`. `task show` includes the field; `task list` adds `no-diff` after the difficulty when set.
- Sidebar prompt (`src/prompts/append-system-prompt.ts`):
  - CLI reference for the flag: "Set true only for research or spike tasks whose deliverable is outside git (for example a local note)."
  - Review step: for a task with `noChangesExpected`, an empty diff is expected; check the deliverable named in the prompt instead, then run `task done --task-id <id> --review-passed` without `--commit`. A task with this flag that does change tracked files fails the round as out of scope.
- No web UI control; the field is only preserved. Per `AGENTS.md`, thread it through every card rebuild in `web-ui/src/state/board-state.ts` (`normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, `disableTaskAutoReview`) so a UI save does not drop it.

## Non-goals

- Changing the nudge for normal tasks.
- A UI toggle.

## Files

- `src/core/api-contract.ts` (card schema, near `agentReviewEnabled` at line 205), `src/commands/task.ts` (create/update/show/list), `src/server/sidebar-review-service.ts` (skip the check), `src/prompts/append-system-prompt.ts`, `web-ui/src/state/board-state.ts`, plus `web-ui/src/types/board.ts` if the card type lives there.
- Tests: the sidebar review service test under `test/runtime/server/` (flag set + clean worktree → no nudge, task queued for review; flag absent → nudge as today), `test/runtime/task-command-*.test.ts` (create/update round-trip, `task list` shows `no-diff`), `test/runtime/append-system-prompt.test.ts`, `web-ui/src/state/board-state.test.ts` (one test per rebuild path keeps the field).

## Acceptance

- The tests above pass; `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck`, `npm --prefix web-ui run test`, `npm run web:build` pass.
