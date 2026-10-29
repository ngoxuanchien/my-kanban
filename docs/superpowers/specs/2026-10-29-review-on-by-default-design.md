# Agent review on by default, and review on enable — design

Date: 2026-10-29
Status: approved by the user in chat (chose both options)
Builds on: `2026-10-29-sidebar-agent-review-design.md`

## Problem

In project Present, five finished tasks sat in Review and the sidebar never reviewed them. All five had `agentReviewEnabled: false`: they were created before the sidebar's CLI reference listed `--agent-review-enabled` (fixed in 42d28d43), so the flag kept its default `false`. Turning the flag on afterwards did not help either: the runtime only queues a review when a task agent **ends a turn**, and `notifyBoardChanged` (`src/server/sidebar-review-service.ts`) only resets cards.

## Changes

1. **On by default. [user]** A new task gets `agentReviewEnabled: true` unless the caller says otherwise.
   - CLI `task create` (`src/commands/task.ts`, `createTask` ~line 543): `input.agentReviewEnabled ?? true`. `--agent-review-enabled false` still turns it off.
   - Web UI new-task state (`web-ui/src/hooks/use-task-editor.ts:117` and the resets at `:386`, `:460`, `:504`): default `true`. The edit-task state stays as the card's own value.
   - Existing cards are not migrated; a missing flag still reads as `false`.
2. **Review on enable. [user]** In `notifyBoardChanged`, for each card in the `review` column with `agentReviewEnabled === true`, `reviewRound` 0, not already queued, whose task session summary is `awaiting_review` (from `terminalManager.listSummaries()` / `clineService.listSummaries()`): run the same path as a turn end (usage-limit check, empty-task nudge, then `queue.onTaskTurnEnd` → round 1 → wake the sidebar). Extract that path from `handleSummary` into one function so both callers share it. Cards with no session summary are skipped. **[assistant's call]**

## Non-goals
- A per-project setting for the default.
- Reviewing cards in other columns.

## Tests
- CLI create without the flag → `agentReviewEnabled: true`; with `false` → `false`.
- UI: new-task toggle starts on, and is on again after a create resets the form.
- Service: card in Review, review just enabled, session `awaiting_review`, round 0 → sidebar woken with round 1. Already round ≥ 1, or queued, or no session, or not in Review → nothing. Running `notifyBoardChanged` twice → one wake-up.
