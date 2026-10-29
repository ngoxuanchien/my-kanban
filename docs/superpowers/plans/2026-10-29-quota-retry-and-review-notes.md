# Quota retry and review notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect Antigravity quota messages, mark tasks stuck because every agent is out of quota with "Out of quota", retry them hourly with the next agent, and let the sidebar reviewer record lessons in `contexte/`.

**Architecture:** A new optional card field `quotaBlockedAt` (epoch ms) is set by the sidebar review service when the quota branch hits the handoff cap. A 5-minute interval in the same service retries due cards through a new internal runtime method that calls `handOffTask` with a cap bypass. The web UI round-trips the field and shows a label. The sidebar prompt gets a generic round rule and a notes step, fed by `handOffCount` in `task list`.

**Tech Stack:** TypeScript, Node runtime (`src/`), React web UI (`web-ui/`), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-29-quota-retry-and-review-notes-design.md`

## Global Constraints

- Retry delay: 1 hour (`3_600_000` ms) after `quotaBlockedAt`. Check interval: 5 minutes (`300_000` ms).
- Retry reason (exact): `Every agent hit its usage limit. Kanban waited 1 hour and is retrying with you.`
- Label text (exact): `Out of quota`.
- New phrases (exact): `exhausted your quota`, `out of quota until`.
- The cap bypass (`quotaRetry`) is runtime-internal: never add it to `runtimeTaskHandOffRequestSchema` (`src/core/api-contract.ts:1059`), the CLI, or a tRPC route.
- A retry does not change `reviewRound` and does not wake the sidebar; it increments `handOffCount`.
- No new dependencies. No `any`. No inline imports.
- Acceptance for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast` pass; web-ui tasks also `npm run web:typecheck` and `npm --prefix web-ui run test -- <file>`.

## Review Focus

1. The UI saves the whole board and its normalizer (`web-ui/src/state/board-state.ts:155-215`) drops unknown fields → a UI save must keep `quotaBlockedAt`. Test in Task 2.
2. A blocked card the user drags out of Review and back must not fire an instant retry → cleared on leaving Review. Test in Task 3.
3. A blocked card after an app restart must not be re-queued for a review that cannot pass. Test in Task 3.
4. The retried agent ends a normal turn (quota is back) → the label must disappear and the normal review path runs. Test in Task 3.
5. `task handoff` from the CLI on a card at the cap must still be refused. Test in Task 2.

## Kanban tasks and order

| Task | Agent | Depends on |
|---|---|---|
| 1. Phrases, `task list` handOffCount, sidebar prompt | codex | — |
| 2. `quotaBlockedAt` field + `quotaRetry` handoff + internal retry method | opencode | — |
| 3. Sidebar review service: set, clear, restart skip, hourly retry | antigravity | 2 |
| 4. Card label | codex | 2 |

Tasks 1 and 2 touch disjoint files and can run in parallel.

---

### Task 1: Antigravity phrases, `handOffCount` in `task list`, sidebar review prompt

**Files:**
- Modify: `src/server/usage-limit-detector.ts:1`
- Modify: `src/commands/task.ts:345-375` (`formatTaskRecord`)
- Modify: `src/prompts/append-system-prompt.ts:329-337` (`# Reviewing tasks`)
- Test: `test/runtime/server/usage-limit-detector.test.ts`, `test/runtime/task-command-agent-id.test.ts` (or a sibling `test/runtime/task-command-record.test.ts` if that file only covers agent ids), `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Produces: `task list` records gain `handOffCount: number` (from `getHandOffCount(task)` in `src/core/hand-off-cap.ts`).

- [ ] **Step 1: Failing tests**
  - Detector: `detectUsageLimit("\x1b[31mYou have exhausted your quota on this model.\x1b[0m")` → `"exhausted your quota"`; `detectUsageLimit("model gemini-pro is OUT OF QUOTA UNTIL 14:00")` → `"out of quota until"`; `detectUsageLimit("You’ve hit your usage limit. Upgrade to Plus to continue using Codex")` → `"hit your usage limit"`.
  - Task record: a card with `handOffCount: 2` → record `handOffCount === 2`; a legacy card with `handedOff: true` and no count → `1`; a plain card → `0`.
  - Prompt: the review section no longer contains `3/3 or 6/6` or `9/9`; it contains the three generic rules and the notes step below (assert on key phrases: `multiple of 3`, `round equals the cap`, `contexte/`).
- [ ] **Step 2: Run** `npx vitest run test/runtime/server/usage-limit-detector.test.ts test/runtime/append-system-prompt.test.ts <task record test>` → FAIL.
- [ ] **Step 3: Implement**
  - Append the two phrases to `USAGE_LIMIT_PHRASES`.
  - Add `handOffCount: getHandOffCount(task)` next to `reviewRound` in `formatTaskRecord`.
  - Rewrite review steps 3–4 and add step 5 in the prompt. Keep steps 1–2 as they are. Content (wording is yours, rules are fixed):
    - 3: fails, round below the cap and not a multiple of 3 → `task send` with the concrete fix list (as today).
    - 4: fails on a round that is a multiple of 3 and below the cap → `task handoff` with the same fix list; if it returns an error, leave it in Review and report the reasons. Fails when the round equals the cap → do not send or hand off; leave it in Review and report.
    - 5: after a pass, only if the round was above 1 or `handOffCount` from `task list` is above 0: write 1–3 lines into the matching existing topic file in `contexte/` (Basic Memory project `my-kanban`, or the file directly if the server is down) with the date and the task title and id: the cause of a failed round and the correct fix, or surprising behaviour of code or a tool. Never a task summary, diff, work log, or secret. New file only if no topic fits, then add it to `MAP.md`. Do not commit these files.
  - Update the existing prompt test expectation at `test/runtime/append-system-prompt.test.ts:93`.
- [ ] **Step 4: Run** the same tests → PASS; then the acceptance commands.
- [ ] **Step 5: Commit** `feat(runtime): agy quota phrases, handOffCount in task list, generic sidebar review rounds`

---

### Task 2: `quotaBlockedAt` field, `quotaRetry` handoff, internal retry method

**Files:**
- Modify: `src/core/api-contract.ts:140-160` (`runtimeBoardCardSchema`)
- Modify: `src/server/hand-off-task.ts`
- Modify: `src/trpc/runtime-api.ts:438-470`, `src/trpc/app-router.ts:241` (runtime API interface only, no route)
- Modify: `web-ui/src/types/board.ts:48`, `web-ui/src/state/board-state.ts:155-215`
- Test: `test/runtime/server/hand-off-task.test.ts`, `test/runtime/api-validation.test.ts`, `web-ui/src/state/board-state.test.ts`

**Interfaces:**
- Produces:
  - `RuntimeBoardCard.quotaBlockedAt?: number` (`z.number().optional()`); web-ui `BoardCard.quotaBlockedAt?: number`.
  - `handOffTask(deps, input: { taskId: string; reason: string; quotaRetry?: boolean })` — `quotaRetry: true` skips only the `MAX_HAND_OFFS` refusal; the saved card has `handOffCount + 1`, the next agent, column `in_progress`, and no `quotaBlockedAt`.
  - Runtime API method `retryQuotaBlockedTask(scope: RuntimeTrpcWorkspaceScope, input: { taskId: string; reason: string }): Promise<RuntimeTaskHandOffResponse>` — same body as `handOffTask` in `runtime-api.ts` but passes `{ ...input, quotaRetry: true }`. Declared on the runtime API interface in `app-router.ts`; **no** tRPC procedure and no CLI command.

- [ ] **Step 1: Failing tests**
  - `hand-off-task.test.ts`: card with `handOffCount: 2`, `agentId: "antigravity"`, `quotaBlockedAt: 123`: without `quotaRetry` → `{ ok: false, error: "Task has already been handed off twice" }` (unchanged); with `quotaRetry: true` → `ok: true`, `toAgentId: "codex"`, saved card `handOffCount: 3`, `quotaBlockedAt` undefined, column `in_progress`; `quotaRetry: true` on a card with review off → still refused with `"Agent review is not enabled for this task"`.
  - `api-validation.test.ts`: `runtimeBoardCardSchema` accepts `quotaBlockedAt: 1_700_000_000_000` and a card without it; `runtimeTaskHandOffRequestSchema.parse({ taskId, reason, quotaRetry: true })` does not yield `quotaRetry`.
  - `board-state.test.ts`: normalizing a card with `quotaBlockedAt: 1_700_000_000_000` keeps it; with `quotaBlockedAt: "x"` or negative → field absent.
- [ ] **Step 2: Run** `npx vitest run test/runtime/server/hand-off-task.test.ts test/runtime/api-validation.test.ts` and `npm --prefix web-ui run test -- src/state/board-state.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces above. In `refusal()`, take `quotaRetry` and skip only the cap check; the in-mutation re-check uses the same rule. Strip `quotaBlockedAt` in the same object spread that strips `handedOff`.
- [ ] **Step 4: Run** the same tests → PASS; then the acceptance commands plus `npm run web:typecheck`.
- [ ] **Step 5: Commit** `feat(runtime): add quotaBlockedAt and an internal quota retry handoff`

---

### Task 3: Sidebar review service — set, clear, restart skip, hourly retry

**Files:**
- Modify: `src/server/sidebar-review-service.ts`
- Modify: `src/server/runtime-server.ts:185-215` (wiring)
- Test: `test/runtime/server/sidebar-review-service.test.ts`

**Interfaces:**
- Consumes (Task 2): `RuntimeBoardCard.quotaBlockedAt`, runtime API `retryQuotaBlockedTask(scope, { taskId, reason })`.
- Produces: new fields on `CreateSidebarReviewServiceDependencies`:
  - `retryQuotaBlockedTask: (taskId: string, reason: string) => Promise<{ ok: boolean; error?: string | null }>`
  - `now?: () => number` (default `Date.now`)
  - Timer injection of your choice (injected `setInterval`/`clearInterval`, or plain timers driven by `vi.useFakeTimers()` in tests).

- [ ] **Step 1: Failing tests** (use the existing harness in the test file; inject `now`):
  1. Turn end, snapshot with a quota phrase, card `handOffCount: 2` → card saved with `quotaBlockedAt === now()`, `handOffTask` and `retryQuotaBlockedTask` not called, sidebar not woken, `broadcastStateUpdated` called, one `warn`.
  2. Tick with Review card blocked 59 min ago → no call; 60 min ago → `retryQuotaBlockedTask("task-1", "Every agent hit its usage limit. Kanban waited 1 hour and is retrying with you.")`.
  3. Blocked card in `in_progress` or with `agentReviewEnabled: false` → no retry.
  4. `start()` with a due blocked Review card → one retry; with `reviewRound: 2` and `quotaBlockedAt` set → not restored to the review queue (sidebar not woken).
  5. `retryQuotaBlockedTask` returns `{ ok: false, error: "x" }` → `warn` contains `x`; card `quotaBlockedAt === now()`.
  6. `notifyBoardChanged` with the blocked card moved to `done`, or with review turned off → `quotaBlockedAt` cleared and saved.
  7. Reviewable turn end without a quota phrase on a blocked card → `quotaBlockedAt` cleared, normal path (nudge or review) runs.
  8. `dispose()` → interval cleared; further ticks do nothing.
- [ ] **Step 2: Run** `npx vitest run test/runtime/server/sidebar-review-service.test.ts` → FAIL.
- [ ] **Step 3: Implement**
  - Quota branch at `sidebar-review-service.ts:98`: when at the cap, `mutateWorkspaceState` to set `quotaBlockedAt = now()` (only if not already set, to avoid a save loop), broadcast, keep the one-time warn, return.
  - Non-quota reviewable turn end: if the card has `quotaBlockedAt`, clear it (save + broadcast) before the normal path.
  - `notifyBoardChanged`: in the existing card map, also drop `quotaBlockedAt` when the card is in trash, has review off, or is in any column other than `review`; mark `changed`.
  - `start()`: skip `queue.restoreTask` for cards with `quotaBlockedAt`; run the retry check once; start the 5-minute interval. `dispose()` clears it.
  - Retry check: load state; for each `review` card with `agentReviewEnabled === true`, `quotaBlockedAt` set, `now() - quotaBlockedAt >= 3_600_000`, and not in `processingTaskIds`: call `deps.retryQuotaBlockedTask(id, reason)`; on `{ ok: false }` warn and set `quotaBlockedAt = now()`. Catch and warn on errors; never throw from the timer.
  - Wire `retryQuotaBlockedTask: async (taskId, reason) => await getInternalRuntimeApi().retryQuotaBlockedTask(scope, { taskId, reason })` in `runtime-server.ts`.
- [ ] **Step 4: Run** the test file → PASS; then the acceptance commands.
- [ ] **Step 5: Commit** `feat(runtime): mark quota-blocked review tasks and retry them hourly`

---

### Task 4: "Out of quota" card label

**Files:**
- Modify: `web-ui/src/components/board-card.tsx:473-488`
- Test: `web-ui/src/components/board-card.test.tsx`

**Interfaces:**
- Consumes (Task 2): web-ui `BoardCard.quotaBlockedAt?: number`.

- [ ] **Step 1: Failing tests**: Review card with `agentReviewEnabled: true`, `quotaBlockedAt: 1` → agent line contains `Out of quota`; same card without the field, or the same card in `in_progress` → no `Out of quota`.
- [ ] **Step 2: Run** `npm --prefix web-ui run test -- src/components/board-card.test.tsx` → FAIL.
- [ ] **Step 3: Implement**: append `Out of quota` to the agent line parts when `columnId === "review"` and `card.quotaBlockedAt` is set; add `card.quotaBlockedAt` and `columnId` to the `useMemo` deps. Render it in `text-status-red` if that fits the line's markup without restructuring it; otherwise plain text.
- [ ] **Step 4: Run** the test → PASS; then `npm run web:typecheck`, `npm run lint`, `npm run test:fast`.
- [ ] **Step 5: Commit** `feat(web-ui): show Out of quota on quota-blocked review cards`

---

## After all tasks
- Record in `contexte/memory-orchestrator.md`: what shipped, the commit hashes, the UI-normalizer gotcha (Review Focus 1), and that Kanban.app needs a rebuild.
