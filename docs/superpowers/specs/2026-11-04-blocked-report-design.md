# Agent reports "blocked" with one question

Date: 2026-11-04
Status: draft

## Why

When a task agent stops because it cannot go on (it needs a decision: "A or B?", missing access, contradicting requirements), Kanban sees an ordinary turn end. The sidebar reviews it, fails the round, and burns review rounds and handoffs on a task that only the owner can unblock. The question sits buried in the terminal.

Idea taken from dsh-superagent (`src/core/assignments.ts:11-20` `WorkerReport` with `state` + one `question`; `docs/003-execution.md:13-14` stage `person / answer`, `person / blocked`; `docs/000-philosophy.md:13` "asks one concrete question at a time, in a structured form"). Kanban keeps only the minimum: a blocked flag and one question.

Builds on `2026-11-04-permission-wait-design.md` (permission waits) and `2026-11-04-needs-owner-label-design.md` (the "Needs you" label).

## Current behavior (evidence)

- Every turn end of a review-enabled task is queued for sidebar review (`src/server/sidebar-review-service.ts:529-531`, `:472-493`).
- The task prompt template ends with "Run every acceptance command yourself and paste the output in your last message" (`docs/agents/task-prompt-template.md`, section "When done"); it has no way to say "I am blocked".
- Task agent sessions already carry `KANBAN_HOOK_TASK_ID` in their environment (`src/terminal/hook-runtime-context.ts:1`, `:19`).
- `.kanban-issue-report.md` (`2026-11-04-github-issue-format-design.md:155-163`) is a GitHub issue report only. This change does not touch it.

## Goal

An agent that cannot continue runs `task report --state blocked --question "<one question>"` before it ends its turn. The board then:
- stores the question on the card;
- shows the card as "Needs you" with the question;
- does not queue the turn end for sidebar review (no round counted, no empty-worktree nudge, no handoff).

When the owner answers (`task send`, or typing in the task terminal) and the session runs again, the blocked report clears and the task flows as today.

A task that finishes normally calls nothing.

## Non-goals

- No `ready` / `failed` / `progress` states. Only `blocked`.
- No answer routing from the board UI (the owner answers in the terminal or with `task send`).
- No change to `.kanban-issue-report.md` or GitHub sync.
- Cline (native SDK agent) is out of scope: it reports nothing, and the clearing listener may ignore `clineService` summaries.

## Anti-goals

- A blocked task must never count a review round or trigger a handoff.
- A stale question must never stay on a card after the agent is working again.

## Design

1. **Card field** `blockedReport?: { question: string; reportedAt: number }` on `runtimeBoardCardSchema` (`src/core/api-contract.ts:197-223`). Thread it through every card rebuild in `web-ui/src/state/board-state.ts` (see AGENTS.md: `normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, `disableTaskAutoReview`).
2. **CLI** `task report --state blocked --question "<text>" [--task-id <id>] [--project-path <path>]` in `src/commands/task.ts`. `--task-id` defaults to `KANBAN_HOOK_TASK_ID`. It sets `blockedReport` with `mutateWorkspaceState` and broadcasts. `--question` is required, trimmed, non-empty, max 500 characters. Only `blocked` is accepted.
3. **One shared guard** `isTaskBlocked(card)` in `src/server/sidebar-review-service.ts`, checked by **every** automated path before it acts: `processReviewableSummary` (`:420`, including its usage-limit check at the top), the crash handoff in `handleSummary` (`:525-560`), the `continue` nudge and quota handoff in `checkStuckTasks` (`:347-389`), and the hourly Out-of-quota retry (`retryQuotaBlockedTasks`, `:142-198`). A blocked card is not queued, nudged, retried, or handed off.
4. **Clearing**: the runtime removes `blockedReport` when any of these happens after `reportedAt`:
   - the task session goes to `running` (use the runtime summary listener from `2026-11-04-runtime-column-sync-design.md` if it has landed, otherwise a listener of the same shape);
   - the card moves to Done or Trash (`task done`, including `--review-passed`, and UI trash);
   - a handoff (`src/server/hand-off-task.ts`).
   After an app restart the field stays until one of these happens.
5. **Label and order**: in every column except Backlog, Done, and Trash, and whether or not agent review is on, a card with `blockedReport` shows "Needs you" with the question (truncated) on its activity line and sorts first. This extends `getCardAttention` from the needs-owner spec: it checks `blockedReport` first, before the review rules, and returns "owner" in In Progress too. It overrides that spec's "no new card field" non-goal for this one field.
5b. **How the owner finds out**: the browser notification fires with `reason: "blocked"` (same mechanism as permission-wait 2b) and title `<workspace> needs you`, body = the question. `task list` prints `blocked: <question>` on the task's line, and `task show` includes `blockedReport`.
6. **Prompt**: add to the "When done" section of `docs/agents/task-prompt-template.md` and to the task-agent instructions Kanban appends: "If you cannot finish without a decision from the owner, run `<kanban prefix> task report --state blocked --question "<one concrete question>"` and stop. Ask one question only."
7. **Sidebar prompt** (`src/prompts/append-system-prompt.ts`, review section): a task with a blocked report is not reviewed; report the question to the user in one line.

## Acceptance

- CLI test: `task report` sets `blockedReport`; rejects a missing or empty question, another state, or an unknown task.
- Sidebar review service tests, one per guarded path: turn end, crash, silent running task, quota phrase, hourly quota retry; each does nothing for a card with `blockedReport`.
- Clearing tests: session back to `running` after `reportedAt` clears; a `running` summary that predates `reportedAt` does not; Done, Trash, and handoff clear.
- Notification test: `reason: "blocked"` shows "needs you" and the question.
- `task list` / `task show` output tests include the question.
- Web-ui test per `board-state.ts` rebuild path keeps `blockedReport`.
- Card test: a card with `blockedReport` shows "Needs you" and the question.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck` pass.

## Left to the builder

- Where Kanban appends task-agent instructions, and the exact CLI prefix text agents receive.
- Truncation length on the card.

## Calls made by the planner (not confirmed by the owner)

- One question, max 500 characters.
- Clearing happens on the next run, not on `task send` itself (a send that fails to start the agent keeps the question visible).
- Every automated path (review, crash handoff, nudge, quota) skips a blocked card.
- The owner is told by card, browser notification, and `task list` / `task show`.
- "Needs you" for a blocked card shows in In Progress and Review, review on or off.
- Done, Trash, and handoff also clear the report. Cline is out of scope.
- Lands after the permission-wait and needs-owner changes.
