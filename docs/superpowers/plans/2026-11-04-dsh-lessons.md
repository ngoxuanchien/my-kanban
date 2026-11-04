# DSH Lessons (permission wait, scope check, needs-owner, column sync, blocked report) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo each task runs as one Kanban task in its own worktree; do not commit — the sidebar reviewer commits on pass.

**Goal:** Make the board say who a task is waiting on (agent, sidebar, or owner) from structured facts instead of guessing from turn ends, and keep columns correct without a UI open.

**Architecture:** Hook ingest keeps permission waits `running`; a per-workspace runtime listener moves cards between In Progress and Review and clears blocked reports; a pure UI function `getCardAttention` labels and orders cards; a new `task report` CLI stores one blocked question on the card.

**Tech Stack:** TypeScript, Node runtime (`src/`), tRPC, zod, React + Tailwind v4 (`web-ui/`), vitest.

**Specs:**
- Task 1: `docs/superpowers/specs/2026-11-04-permission-wait-design.md`
- Task 2: this plan (no spec; small prompt change)
- Task 3: `docs/superpowers/specs/2026-11-04-needs-owner-label-design.md`
- Task 4: `docs/superpowers/specs/2026-11-04-runtime-column-sync-design.md`
- Tasks 5–6: `docs/superpowers/specs/2026-11-04-blocked-report-design.md`

Order: 1 → 3, 1 → 4, 4 → 5, 3 + 5 → 6. Task 2 is independent.

## Global Constraints

- Before and after each task: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck` all pass; paste the output.
- No new dependency.
- Every test that spawns `git` passes `env: createGitTestEnv()` (`test/utilities/git-env.ts`).
- A new optional card field is threaded through every card rebuild in `web-ui/src/state/board-state.ts` (AGENTS.md list), with one web-ui test per path.
- UI copy is English: `Waiting for approval`, `Needs you`, `Sidebar`, `<workspace> needs approval`, `<workspace> needs you`.
- Colors from tokens only: approval wait `--color-status-gold` (existing `waiting`), `Needs you` status-orange, `Sidebar` text-tertiary.
- No `any`, no inline imports.

## Review Focus

1. A permission request from an agent whose payload has `notification_type` but a different `hook_event_name` (Claude `Notification` + `permission_prompt`) must still stay `running` — Task 1 test covers all three shapes.
2. Two permission requests in a row in one turn must produce one notification each, not crash or double-move — Task 1 test.
3. A Review card whose session is gone after an app restart must show `Needs you`, not `Sidebar` — Task 3 test.
4. A runtime move arriving while the owner drags a card must not leave the card in two columns or none — Task 4 concurrency test.
5. An agent that calls `task report` twice must keep only the latest question — Task 5 test.

---

### Task 1: Permission wait stays In Progress

**Files:**
- Create: `src/core/permission-hook.ts`
- Modify: `src/trpc/hooks-api.ts:148-250`, `src/core/api-contract.ts:527-532`, `src/server/sidebar-review-service.ts:357-375`, `src/terminal/agent-session-adapters.ts:314-352` (OpenCode plugin), `web-ui/src/hooks/use-review-ready-notifications.ts:183-192`, `web-ui/src/components/board-card.tsx:155-221`
- Test: `test/runtime/trpc/hooks-api.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, `test/runtime/terminal/opencode-plugin.test.ts`, `web-ui/src/components/board-card.test.tsx`, new `web-ui/src/hooks/use-review-ready-notifications.test.tsx`

**Interfaces:**
- Produces: `isPermissionRequestHook(metadata: { hookEventName?: string | null; notificationType?: string | null } | null | undefined): boolean` and `isPermissionWaitActivity(activity: RuntimeTaskHookActivity | null | undefined): boolean` (true iff `activity.activityText === "Waiting for approval"`), both in `src/core/permission-hook.ts`.
- Produces: `runtimeStateStreamTaskReadyForReviewMessageSchema` gains `reason: z.enum(["permission", "blocked"]).optional()` (`"blocked"` is used by Task 6).

- [ ] **Step 1: Failing tests**
  - `hooks-api.test.ts` › `keeps a running session running on a permission to_review` — for each metadata `{hookEventName:"PermissionRequest"}`, `{notificationType:"permission_prompt"}`, `{hookEventName:"PermissionRequest", notificationType:"permission.asked"}`: summary state stays `"running"`, `latestHookActivity.activityText === "Waiting for approval"`, checkpoint capture not called, `broadcastTaskReadyForReview` called once with `reason: "permission"`.
  - same file › `moves to awaiting_review on a plain Stop to_review` — state `"awaiting_review"`, `reviewReason: "hook"`, no `reason`.
  - same file › `two permission hooks in one turn broadcast twice and stay running`.
  - `sidebar-review-service.test.ts` › `does not nudge or hand off a running task waiting for approval` — activity "Waiting for approval", `lastOutputAt` older than 300000 ms: no `sendPromptToSession`, no `handOffTask`.
  - same › `still nudges a silent running task after the approval is answered` — `activityText` replaced, `notificationType` still `"permission_prompt"`: nudge sent.
  - `opencode-plugin.test.ts` › `permission.asked then succeeded sends activity then review` — after 500 ms, one `activity` with `hook_event_name: "PermissionRequest"`, then `session.execution.succeeded` sends one `review`; `permission.replied` before 500 ms sends nothing.
  - `board-card.test.tsx` › `shows Waiting for approval even with a stored toolName`.
  - `use-review-ready-notifications.test.tsx` › title `"<ws> needs approval"` for `reason: "permission"`, `"<ws> ready for review"` without.
- [ ] **Step 2: Run** `npx vitest run test/runtime/trpc/hooks-api.test.ts test/runtime/server/sidebar-review-service.test.ts test/runtime/terminal/opencode-plugin.test.ts` and `npm --prefix web-ui run test -- board-card use-review-ready-notifications` → new tests FAIL.
- [ ] **Step 3: Implement** the two predicates; in `hooks-api.ts` branch before `canTransitionTaskForHookEvent` for `to_review` + predicate (apply activity, broadcast state, broadcast ready-for-review with `reason: "permission"`, return ok), and do the same broadcast for an `activity` event matching the predicate (OpenCode path); guard `checkStuckTasks` silence with `isPermissionWaitActivity`; OpenCode plugin sends `notify("activity", …)` instead of forced `handleReview` and `permission.replied` only clears the timer; card returns the waiting label before `resolveToolCallLabel` when `activityText` is "Waiting for approval"; notification title by `reason`.
- [ ] **Step 4: Run** the same commands → PASS, then the four global checks → PASS.

### Task 2: Sidebar reviewer checks scope

**Files:**
- Modify: `src/prompts/append-system-prompt.ts:441-443`
- Test: `test/runtime/append-system-prompt.test.ts`

**Interfaces:** none.

- [ ] **Step 1: Failing test** `append-system-prompt.test.ts` › `review step fails out-of-scope changes` — the home-agent prompt contains `changes outside the task prompt's scope or "Files you may change" fail the round` and `suggest a separate task to the user in chat; do not create it`.
- [ ] **Step 2: Run** `npx vitest run test/runtime/append-system-prompt.test.ts` → FAIL.
- [ ] **Step 3: Implement** in review step 1 add: "Also compare the diff with the prompt's scope and its \"Files you may change\" list: changes outside the task prompt's scope or \"Files you may change\" fail the round." In step 3 append to the fix list rule: "For out-of-scope changes, ask the agent to revert them, and suggest a separate task to the user in chat; do not create it."
- [ ] **Step 4: Run** → PASS, then the four global checks.

### Task 3: "Needs you" / "Sidebar" label and ordering

**Files:**
- Create: `web-ui/src/kanban/card-attention.ts`
- Modify: `web-ui/src/components/board-card.tsx:498-513`, the column render and drop handling for Review / In Progress (`web-ui/src/components/kanban-board.tsx` and `web-ui/src/hooks/use-board-interactions.ts` drag-end)
- Test: `web-ui/src/kanban/card-attention.test.ts`, `web-ui/src/components/kanban-board.test.tsx`

**Interfaces:**
- Consumes: `isPermissionWaitActivity` (Task 1); `getHandOffCount`, `getReviewRoundCap`, `MAX_HAND_OFFS`, `isHandOffAgentId` from `src/core/hand-off-cap.ts`.
- Produces: `getCardAttention(card: BoardCard, columnId: BoardColumnId, summary: RuntimeTaskSessionSummary | undefined): "owner" | "sidebar" | "approval" | null` and `sortCardsByAttention(cards, columnId, sessions): BoardCard[]` (stable; Review: owner first; In Progress: approval first). Task 6 adds a `blockedReport` check at the top.

- [ ] **Step 1: Failing tests** in `card-attention.test.ts`, one per row of the spec table:
  - sidebar: quota-blocked; `awaiting_review`+`hook` below cap; `exit` 0 below cap; at cap with `handOffCount` 1 and agent `codex`; `failed` with matching agent and handoffs left.
  - owner: review off; no summary; `idle`; `interrupted`; `failed` with agent mismatch; `failed` with `handOffCount` 2; at cap with `handOffCount` 2.
  - In Progress with "Waiting for approval" → `"approval"`; other columns → `null`.
  - `kanban-board.test.tsx` › `renders owner cards first in Review keeping relative order`, `renders approval wait first in In Progress`, `drops a dragged card at the shown position in a sorted column`.
- [ ] **Step 2: Run** `npm --prefix web-ui run test -- card-attention kanban-board` → FAIL.
- [ ] **Step 3: Implement** `getCardAttention`, `sortCardsByAttention`; append `Needs you` / `Sidebar` to the agent line in Review; render sorted lists and translate the drop index from displayed order back to stored order by card id.
- [ ] **Step 4: Run** → PASS, then the four global checks.

### Task 4: Runtime moves cards between In Progress and Review

**Files:**
- Create: `src/server/session-column-sync.ts`
- Modify: `src/server/runtime-server.ts:190-215` (wire next to `ensureSidebarReviewService`), `web-ui/src/hooks/use-board-interactions.ts:457-480` (remove the two auto-move branches)
- Test: `test/runtime/server/session-column-sync.test.ts`, `web-ui/src/hooks/use-board-interactions.test.tsx`

**Interfaces:**
- Consumes: `moveTaskToColumn` (`src/core/task-board-mutations.ts:499`), `mutateWorkspaceState`, `isHomeAgentSessionId`.
- Produces: `createSessionColumnSync(deps: { workspaceId: string; workspacePath: string; terminalManager: Pick<TerminalSessionManager, "onSummary" | "listSummaries">; clineService: { onSummary(listener: (s: RuntimeTaskSessionSummary) => void): () => void }; onBoardMoved: () => Promise<void>; warn: (m: string) => void; }): { start(): Promise<void>; stop(): void; onSummary(listener: (event: { summary: RuntimeTaskSessionSummary; previous: RuntimeTaskSessionSummary | undefined }) => void): () => void }`. `onBoardMoved` runs `onWorkspaceStateChanged`, `broadcastRuntimeProjectsUpdated`, and the workspace broadcast. The `onSummary` re-emit is the transition hook Task 5 uses for clearing.

- [ ] **Step 1: Failing tests** in `session-column-sync.test.ts` (temp workspace, `createGitTestEnv()` if git is spawned):
  - `moves in_progress to review on running→awaiting_review` and `review to in_progress on awaiting_review→running`, saved state checked, card at top.
  - `ignores activity-only updates` — same state, new activity: no write.
  - `start reconciles in_progress cards already awaiting_review`.
  - `never moves backlog, trash, or home-agent sessions`.
  - `calls onBoardMoved once per move`.
  - `stale-revision UI save after a move is rejected and the move stays`.
  - `use-board-interactions.test.tsx` › `does not move cards on session state changes` and `renders runtime board column change`.
- [ ] **Step 2: Run** `npx vitest run test/runtime/server/session-column-sync.test.ts` and `npm --prefix web-ui run test -- use-board-interactions` → FAIL.
- [ ] **Step 3: Implement** the listener (track previous summary per task; act only when `state` changes), wire it in `runtime-server.ts`, remove the UI branches.
- [ ] **Step 4: Run** → PASS, then the four global checks.

### Task 5: `task report --state blocked` (runtime + CLI + prompts)

**Files:**
- Modify: `src/core/api-contract.ts:197-223` (card field), `src/commands/task.ts` (new `report` command; `task list` line; `task show`), `src/server/sidebar-review-service.ts` (guard), `src/server/hand-off-task.ts`, `src/core/task-board-mutations.ts` (clear on trash/done), `src/server/runtime-server.ts` (clear on transition via Task 4 `onSummary`), `src/prompts/append-system-prompt.ts` (CLI reference + review rule), `docs/agents/task-prompt-template.md` ("When done"), the task-agent instruction Kanban appends
- Create: `src/core/blocked-report.ts`
- Test: new `test/runtime/task-command-report.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, `test/runtime/server/session-column-sync.test.ts`, `test/runtime/task-board-mutations.test.ts`, `test/runtime/server/hand-off-task.test.ts`, `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Consumes: Task 4 `createSessionColumnSync(...).onSummary`.
- Produces: card field `blockedReport?: { question: string; reportedAt: number }`; `isTaskBlocked(card: Pick<RuntimeBoardCard, "blockedReport">): boolean` and `clearBlockedReport(board: RuntimeBoardData, taskId: string): RuntimeBoardData` in `src/core/blocked-report.ts`.

- [ ] **Step 1: Failing tests**
  - `task-command-report.test.ts`: sets `blockedReport` from `KANBAN_HOOK_TASK_ID`; rejects missing/empty/whitespace question, question over 500 chars, `--state ready`, unknown task; a second call replaces the question and `reportedAt`.
  - `sidebar-review-service.test.ts`: blocked card → no queue/round on turn end, no crash handoff, no `continue` nudge when silent, no quota handoff on a quota phrase, skipped by hourly quota retry.
  - `session-column-sync.test.ts` (or a sibling): transition to `running` after `reportedAt` clears; a summary with `updatedAt` before `reportedAt` does not.
  - `task-board-mutations.test.ts`: trash/done clears; `hand-off-task.test.ts`: handoff clears.
  - `task list` output contains `blocked: <question>`; `task show` JSON has `blockedReport`.
  - `append-system-prompt.test.ts`: CLI reference documents `task report`; review section says a blocked task is not reviewed and its question is reported in one line.
- [ ] **Step 2: Run** the listed files → FAIL.
- [ ] **Step 3: Implement** field, CLI (commander like sibling commands, `mutateWorkspaceState`, broadcast), guard at the top of each listed path, clearing at the three sites plus the transition listener, prompt and template lines (spec Design 6–7 copy).
- [ ] **Step 4: Run** → PASS, then the four global checks.

### Task 6: Blocked report in the UI

**Files:**
- Modify: `web-ui/src/state/board-state.ts` (all rebuild sites), `web-ui/src/kanban/card-attention.ts`, `web-ui/src/components/board-card.tsx`, `web-ui/src/hooks/use-review-ready-notifications.ts`, the runtime broadcast after `task report` saves (`src/commands/task.ts` → runtime tRPC)
- Test: `web-ui/src/state/board-state.test.ts`, `web-ui/src/kanban/card-attention.test.ts`, `web-ui/src/components/board-card.test.tsx`, `web-ui/src/hooks/use-review-ready-notifications.test.tsx`

**Interfaces:**
- Consumes: `blockedReport` (Task 5), `getCardAttention` (Task 3), `reason` enum (Task 1).

- [ ] **Step 1: Failing tests**
  - `board-state.test.ts`: one test per rebuild path keeps `blockedReport`.
  - `card-attention.test.ts`: blocked → `"owner"` in In Progress and Review, review on or off; `null` in Backlog/Done/Trash.
  - `board-card.test.tsx`: shows `Needs you` and the truncated question.
  - notification test: `reason: "blocked"` → title `"<ws> needs you"`, body = question.
- [ ] **Step 2: Run** `npm --prefix web-ui run test -- board-state card-attention board-card use-review-ready-notifications` → FAIL.
- [ ] **Step 3: Implement** threading, the `blockedReport` check first in `getCardAttention`, card line, notification branch; runtime broadcasts `task_ready_for_review` with `reason: "blocked"` after `task report` saves.
- [ ] **Step 4: Run** → PASS, then the four global checks.
