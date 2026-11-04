# Permission wait is not a finished turn

Date: 2026-11-04
Status: draft

## Why

When a task agent stops to ask for permission ("may I run this command?"), Kanban treats it exactly like a finished turn. The owner only finds out by opening the card. Meanwhile the sidebar reviewer may count a review round or nudge the task about an empty worktree, though the agent has not finished anything.

Idea taken from dsh-superagent (`docs/001-domain.md`, rejected concept "Inferring 'waiting on a person' from a report's free text"): a wait for a person must be its own structured fact, not something guessed from the turn end.

## Current behavior (evidence)

- Every agent sends the same `to_review` hook for a permission request and for a turn end:
  - Claude: `PermissionRequest` and `Notification` matcher `permission_prompt` (`src/terminal/agent-session-adapters.ts:466-471`, `:483-486`).
  - Codex: `PermissionRequest` (`src/terminal/codex-hook-config.ts:151-155`).
  - OpenCode plugin: `permission.asked` sends review with `hook_event_name: "PermissionRequest"`, `notification_type: "permission.asked"` (`src/terminal/agent-session-adapters.ts:347-351`); `permission.replied` sends `in_progress`.
- The hooks API turns any `to_review` on a running session into `awaiting_review` with `reviewReason: "hook"` (`src/trpc/hooks-api.ts:153-155`, `:207`; `src/terminal/session-state-machine.ts:31-41`).
- The web UI moves an `awaiting_review` card from In Progress to Review (`web-ui/src/hooks/use-board-interactions.ts:457-466`).
- The sidebar review service treats `awaiting_review` + `hook` as a finished turn (`src/server/sidebar-review-service.ts:529-531`): it nudges an empty worktree (`:454-459`) or increments `reviewRound` and wakes the sidebar (`:472-493`).
- The hook CLI already labels `notificationType` `permission_prompt` / `permission.asked` as "Waiting for approval" (`src/commands/hooks.ts:255-257`); the card shows that text with the `waiting` (gold) color (`web-ui/src/components/board-card.tsx:43`, `:201-202`).

## Goal

A `to_review` hook that is a permission request leaves the session `running`. The card stays in In Progress and shows "Waiting for approval". No review, no review round, no empty-worktree nudge, no `continue` nudge. When the agent resumes, the label clears as it does today.

## Non-goals

- No escalation for a long permission wait (owner decision): no nudge, no handoff, no column move, no timer. The card stays in In Progress with the label until the owner answers in the terminal.

- A general structured end-of-turn report (a separate proposal).
- Agents without a permission hook (Antigravity, Cline, others) keep their current behavior.
- New notification channels (sound, OS notification). The existing browser notification is kept, retitled (Design 2b).

## Anti-goals

- A permission request must never count a review round or trigger handoff.
- Kanban must never type `continue` (or anything) into a session waiting on a permission prompt.

## Design

1. **One shared predicate** `isPermissionRequestHook(metadata)` in `src/core/` (with the hook contract types): true when `hookEventName` equals `PermissionRequest` (case-insensitive), or `notificationType` is `permission_prompt` or `permission.asked`.
2. **Hooks API** (`src/trpc/hooks-api.ts`): for `event === "to_review"` where the predicate holds, do not transition. Apply the hook activity only (`manager.applyHookActivity`), broadcast the workspace state, and return `ok`. Skip checkpoint capture and session capture. Still call `broadcastTaskReadyForReview`, with a new optional field `reason: "permission"` on `runtimeStateStreamTaskReadyForReviewMessageSchema` (`src/core/api-contract.ts:527-532`); a plain turn end sends no `reason`.
2b. **Browser notification** (`web-ui/src/hooks/use-review-ready-notifications.ts:189-192`): owner decision — keep the notification on a permission wait, with title `<workspace> needs approval` (or `Needs approval`) instead of `ready for review`. Same gating as today (`readyForReviewNotificationsEnabled`, visibility). The OpenCode `activity` path in step 6 must also produce this notification; the simplest route is for the hooks API to treat an `activity` that matches the predicate the same way (broadcast with `reason: "permission"`) once per wait.
3. **Activity text**: already done. `inferActivityText` returns "Waiting for approval" for a `PermissionRequest` hook event (`src/commands/hooks.ts:237-238`) and for `permission_prompt` / `permission.asked` (`:255-257`).
4. **Clearing the label**: `applyHookActivity` (`src/terminal/session-manager.ts:846-881`) merges fields and keeps any field a new hook leaves out, so `notificationType: "permission_prompt"` and an earlier `toolName` survive later hooks. The label clears on the next tool hook (Claude `PostToolUse`, Codex `PostToolUse`) or on `Stop`. A denied permission clears at the next hook too; no extra signal is needed. Tests check the **rendered card label** (`web-ui/src/components/board-card.tsx` `getCardSessionActivity`), not only `activityText`, because `resolveToolCallLabel` (`:122-142`) can show a kept tool name instead of "Waiting for approval". The builder makes the card show "Waiting for approval" whenever `activityText` is that string.
5. **No `continue` nudge** (`src/server/sidebar-review-service.ts` `checkStuckTasks`, `:366-375`): a running task is not treated as silent while its stored `latestHookActivity` is a live permission wait. On the stored activity, a live wait means `activityText === "Waiting for approval"`. Do **not** use `notificationType` here: the merge keeps it after the agent resumes. A usage-limit phrase on screen still counts.
6. **OpenCode plugin** (`src/terminal/agent-session-adapters.ts:314-352`): on `permission.asked`, after `PERMISSION_REVIEW_DELAY_MS`, send an `activity` event with `hook_event_name: "PermissionRequest"`, `notification_type: "permission.asked"`, instead of the forced `handleReview`. The plugin then stays `busy` and keeps `rootSessionID`, so the real turn end (`session.execution.succeeded` / `failed` / `interrupted`) still sends `to_review`. `permission.replied` only clears the pending timer. The server-side branch in step 2 stays as a guard for agents that still send `to_review`.

## Constraints

- Follow the existing hook flow. No new hook event name, no new session state, no new `reviewReason`.
- Keep the change behind the shared predicate so all three agents and both runtime sites use one definition.

## Acceptance

- `test/runtime/trpc/hooks-api.test.ts`: a `to_review` with each of the three permission metadata shapes leaves the session `running`, sets activity "Waiting for approval", and does not call checkpoint capture, and calls `broadcastTaskReadyForReview` with `reason: "permission"`; a plain `to_review` (Stop) still moves to `awaiting_review`.
- OpenCode plugin test: `permission.asked` then `session.execution.succeeded` sends one `activity` (permission) and then one `to_review`; `permission.replied` before the delay sends nothing.
- Notification hook test: a message with `reason: "permission"` shows the "needs approval" title; without `reason` it shows "ready for review".
- Card test: the rendered label is "Waiting for approval" even when `toolName` from an earlier `PreToolUse` is still stored.
- Sidebar review service test: a running task with a permission activity older than `QUOTA_NUDGE_WAIT_MS` gets no `continue` and no handoff.
- Test that a later `activity` / `to_in_progress` hook clears the label for Claude, Codex, and OpenCode metadata.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck` pass.

## Left to the builder

- Exact file for the predicate and its name.
- Whether `applyHookActivity` already broadcasts; avoid a double broadcast.

## Calls made by the planner (not confirmed by the owner)

- The label uses the existing `waiting` color (gold, `--color-status-gold`) rather than a new orange token.
- The stored-activity check uses `activityText`, not `notificationType` (merge keeps the latter).
- The OpenCode plugin sends the permission wait as `activity` and stays busy, so a denied permission cannot lose the real turn end.
- A label still showing after a denial clears at the next hook or `Stop`; no dedicated denial signal.
- Codex's `PermissionRequest` hook payload carries `hook_event_name: "PermissionRequest"`; the builder verifies it with `test/runtime/hooks-codex-parser.test.ts` fixtures.
