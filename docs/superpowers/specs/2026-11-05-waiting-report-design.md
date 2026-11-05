# Agent reports waiting for a background job

Date: 2026-11-05
Status: implementation split across two tasks

## Problem

A task agent starts a long background command (for example a three-hour experiment) and ends its turn while the command runs. The Stop hook sets the session to `awaiting_review`; `src/server/session-column-sync.ts` moves its card to Review. The sidebar reviews unfinished work or sends empty-worktree and quota nudges. When the agent resumes, the card jumps back to In progress. Path Planning task 28703 flipped between In progress and Review five times in six minutes.

## Goal

`task report --state waiting --reason "<text>" [--pid <pid>]` keeps the card in In progress, labeled `Waiting: <reason>`, without review, round counting, nudges, quota actions, or automatic handoff until work resumes or the watched process exits.

Split: task 1 runtime+CLI, task 2 UI+prompts.

## Design

1. **Card field and helpers.** Add `waitingReport?: { reason: string; reportedAt: number; pid?: number }` beside `blockedReport` in `runtimeBoardCardSchema` (`src/core/api-contract.ts`). The reason is trimmed, non-empty, and at most 500 characters. A PID is a positive integer. Add `isTaskWaiting(card)` and `clearWaitingReport(board, taskId)` in `src/core/waiting-report.ts`, following `src/core/blocked-report.ts`. Setting waiting clears blocked; setting blocked clears waiting.
2. **CLI.** Extend the existing report command in `src/commands/task.ts` with `task report --state waiting --reason "<text>" [--pid <pid>] [--task-id <id>] [--project-path <path>]`. `--question` is required only for blocked; `--reason` only for waiting. Task ID defaults to `KANBAN_HOOK_TASK_ID` and workspace resolution follows the existing blocked-report command. `task show` includes the report; `task list` includes `waiting: <reason>` on the task line. Existing blocked behavior remains supported.
3. **Column sync.** `moveForSummary` in `src/server/session-column-sync.ts` does not move a waiting card from In progress to Review on `awaiting_review`. The session state itself still changes. Startup reconciliation respects the same guard.
4. **Automation guards.** All paths guarded by `isTaskBlocked` in `src/server/sidebar-review-service.ts` also skip waiting cards: turn-end review queue and round counting, empty-worktree nudges, silent-running `continue` nudges, quota nudges and handoffs, hourly quota retries, and crash handoffs. Restoring or delivering an already queued review must also respect waiting reports.
5. **Clearing.** Mirror blocked-report clearing, using the runtime session-column-sync lifecycle. Clear on a transition from another state into `running` whose `updatedAt` is strictly after `reportedAt`. Activity-only running updates and older/equal summaries leave it intact. Done/Trash and explicit handoff clear it at the existing blocked-report removal sites. Session exit/error also clears it and moves an In progress card to Review. `awaiting_review` with an exit/error reason is a terminated turn, unlike a Stop-hook report from a live terminal. Reconcile terminated sessions at runtime startup as well. Pass whether a report was cleared through the serialized session-sync event, so a terminating wait can enter normal Review without triggering a crash handoff from the same event.
6. **PID watcher.** Add `src/server/waiting-pid-watcher.ts`, started and stopped per workspace alongside session-column-sync in `runtime-server.ts`. Check every report with a PID once at startup, then every 30 seconds using `process.kill(pid, 0)`: ESRCH means gone; EPERM means alive. A dead PID wakes a live task terminal through `sendPromptToSession` with `[Kanban] Background job <pid> exited. Check its output and continue the task.`, then clears the report. A live terminal includes `awaiting_review` with a non-null session PID: the watcher must wake an agent that ended its turn while its background job ran. If the session is unavailable, or delivery reports it unavailable, clear the report and move its In progress card to Review. Protect replacement reports and completed cards when a prompt is in flight. Do not overlap polling passes. Timers are stoppable and unref'd. Tests use fake time and injected PID liveness; never spawn long-running processes.
7. **UI (task 2).** Preserve the optional field at every explicit card rebuild in `web-ui/src/state/board-state.ts`: `normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, and `disableTaskAutoReview`. Show truncated `Waiting: <reason>` on the In progress card activity line. Waiting is not `Needs you`, does not sort first, and does not produce a review-ready browser notification.
8. **Prompts (task 2).** Add to `appendKanbanNotesFooter` in `src/trpc/runtime-api.ts` and the “When done” section of `docs/agents/task-prompt-template.md`: 'If a command will run longer than 10 minutes, start it in the background, then run `<prefix> task report --state waiting --reason "<what and how long>" --pid <pid>` before you end your turn. Kanban wakes you when the process exits.' Extend the CLI reference in `src/prompts/append-system-prompt.ts`; reviewing tasks step 0 skips waiting tasks and reports their reason in one line.

## Non-goals

No maximum wait timeout, output capture, GitHub sync changes, or native Cline-agent support.

## Acceptance: task 1

- CLI sets reason, timestamp and optional PID; rejects missing/empty/over-500 reasons, invalid PIDs and unknown tasks. Blocked still requires a question. Reports replace each other. List/show expose waiting.
- A waiting card stays In progress on `awaiting_review`, including startup; an ordinary card still moves.
- Turn end, silent running, quota phrases, hourly quota retry and crash do nothing for waiting cards.
- Fresh resume clears; stale running summaries do not. Done, Trash, handoff and session exit clear; exit moves to Review.
- PID watcher: alive does nothing; gone/live prompts once then clears; gone/stopped clears and moves to Review; stop cancels timers. Cover ESRCH and EPERM without probing real processes.
- Run `npm run typecheck`, `npm run web:typecheck`, `npm run test:fast`, `npm run lint`, `npm --prefix web-ui run test`, and `npm run web:build`.

## Acceptance: task 2

- Every named web-ui card rebuild preserves the field.
- Waiting shows the reason in In progress, has ordinary ordering, and never shows `Needs you` or fires review-ready notifications.
- Task and sidebar prompts explain reporting and skipping waiting work as above.
- Run the same six acceptance commands.
