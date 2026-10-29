# Agent Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a review-enabled Codex/OpenCode task fails review round 3 or crashes, Kanban hands it once to the other agent, which continues in the same worktree for review rounds 4–6.

**Architecture:** A runtime function `handOffTask` (new `src/server/hand-off-task.ts`) switches the card's agent, marks it `handedOff`, and restarts the session in the existing worktree with a handoff prompt. It is exposed as the tRPC mutation `runtime.handOffTask` (used by the new CLI `task handoff`, which the sidebar runs on a failed round 3) and injected into the sidebar review service (crash trigger). The review queue cap becomes 6 for handed-off cards.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), zod, tRPC, vitest, commander.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-handoff-design.md`

## How to run this plan on the board

Three Kanban tasks, chained: Task 2 waits on Task 1, Task 3 waits on Task 2. Agents: Task 1 codex, Task 2 opencode, Task 3 codex. All with `--agent-review-enabled true`.

## Global Constraints

- Handoff pool: `codex` ↔ `opencode` only. Any other `agentId` (including `claude`, `cline`, unset) → refuse.
- At most one handoff per task (`handedOff === true` → refuse).
- Only cards with `agentReviewEnabled === true`.
- Round cap: `handedOff ? 6 : 3`. Wake-up text: `[Kanban review] Task <id> "<title>" is in Review, round <n>/<cap>. Review it now.`
- Never recreate or reset the worktree during a handoff.
- Handoff prompt (exact):
  ```
  <original task prompt>

  ---
  [Kanban handoff] Another agent (<old agent>) worked on this task before you and could not finish it.
  Its unfinished work is already in this worktree (uncommitted changes and commits since <baseRef>). Check it and continue from it; do not start over.
  Why it was handed off: <reason>
  ```
- Crash reason text (exact): `The previous agent stopped with an error (exit code <n>).` (`<n>` = `unknown` when `exitCode` is null).
- Repo rules: no `any`, no inline/dynamic imports. `npm run lint` now runs `biome check` (formatting included).

## Review Focus

1. Handoff while the old session is still alive (sidebar runs `task handoff` right after round 3) → old session stopped before the new one starts; no two sessions on one task. Test in Task 1.
2. Runtime restart after a handoff (`start()` restore) → a handed-off card in Review with `reviewRound` 4–6 is re-queued with cap 6, not dropped because `reviewRound >= 3`. Test in Task 1.
3. `task handoff` on an unknown id or a refused card → JSON error, exit code non-zero, board unchanged. Test in Task 2.
4. Crash of a handed-off task → no second handoff; it goes to Review as today. Test in Task 3.
5. Start of the new session fails → card keeps `handedOff: true` and the new `agentId`, error returned (no silent success). Test in Task 1.

---

### Task 1: Card field, queue cap, `handOffTask` (codex)

**Files:**
- Modify: `src/core/api-contract.ts:140-141` (add `handedOff: z.boolean().optional()` next to `reviewRound`)
- Modify: `web-ui/src/types/board.ts:46-47`, `web-ui/src/state/board-state.ts:27,160-206` (type + normalize `handedOff`, default `false`, same as `agentReviewEnabled`)
- Modify: `src/server/sidebar-review-queue.ts` (cap)
- Modify: `src/server/sidebar-review-service.ts` (`start()` restore range and `notifyBoardChanged` reset)
- Create: `src/server/hand-off-task.ts`
- Test: `test/runtime/server/sidebar-review-queue.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, `test/runtime/server/hand-off-task.test.ts`, `web-ui/src/state/board-state.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type HandOffAgentId = "codex" | "opencode";
  export interface HandOffTaskDependencies {
  	workspacePath: string;
  	stopTaskSession: (taskId: string) => Promise<void>;
  	startTaskSession: (input: {
  		taskId: string; prompt: string; taskTitle: string; baseRef: string; agentId: HandOffAgentId;
  	}) => Promise<{ ok: boolean; error?: string | null }>;
  	broadcastStateUpdated: () => Promise<void> | void;
  }
  export type HandOffTaskResult =
  	| { ok: true; taskId: string; fromAgentId: HandOffAgentId; toAgentId: HandOffAgentId }
  	| { ok: false; error: string };
  export function buildHandOffPrompt(input: { originalPrompt: string; fromAgentId: HandOffAgentId; baseRef: string; reason: string }): string;
  export async function handOffTask(deps: HandOffTaskDependencies, input: { taskId: string; reason: string }): Promise<HandOffTaskResult>;
  ```
  `SidebarReviewTask` gains `handedOff?: boolean`.

- [x] **Step 1: Failing tests**
  - queue: `handedOff: true, reviewRound: 3` → `onTaskTurnEnd` returns `{ round: 4 }` and `onSidebarIdle()` is `... round 4/6. Review it now.`; `reviewRound: 6` → `null`; not handed off `reviewRound: 3` → `null` (unchanged).
  - service `start()`: card in review, `handedOff: true`, `reviewRound: 5` → queued (Review Focus 2). `notifyBoardChanged` with review turned off → `handedOff` saved as `false`.
  - `hand-off-task.test.ts` (mock `loadWorkspaceState`/`mutateWorkspaceState` like `sidebar-review-service.test.ts` does): codex→opencode and opencode→codex; refuses `handedOff`, review-off, `claude`, unknown id (board unchanged); `stopTaskSession` called before `startTaskSession` (Review Focus 1); start input has the new `agentId`, the card's `baseRef`, and `buildHandOffPrompt(...)`; card saved with new `agentId`, `handedOff: true`, column `in_progress`, `reviewRound` unchanged; start returns `{ ok: false, error: "x" }` → result `{ ok: false, error: "x" }`, card still `handedOff: true` (Review Focus 5).
  - `buildHandOffPrompt` equals the exact Global Constraints text.
  - board-state: card without `handedOff` normalizes to `false`.
- [x] **Step 2:** `npx vitest run test/runtime/server` → new tests FAIL.
- [x] **Step 3: Implement.** Queue cap = `task.handedOff === true ? 6 : 3` in `onTaskTurnEnd` and the wake-up text. Service restore range `1..cap`. `handOffTask`: validate on loaded state → `stopTaskSession` → `mutateWorkspaceState` (set `agentId`, `handedOff: true`, then `moveTaskToColumn(board, taskId, "in_progress")` from `src/core/task-board-mutations.ts`) → `startTaskSession` → `broadcastStateUpdated`.
- [x] **Step 4:** `npm run typecheck && npm run test:fast && npm run lint && npm --prefix web-ui run test` → PASS.

### Task 2: tRPC endpoint, CLI `task handoff`, sidebar instructions (opencode)

**Files:**
- Modify: `src/core/api-contract.ts` (`runtimeTaskHandOffRequestSchema = z.object({ taskId: z.string(), reason: z.string().min(1) })`, response `{ ok: boolean; error?: string | null; fromAgentId?; toAgentId? }`)
- Modify: `src/trpc/runtime-api.ts` (add `handOffTask(workspaceScope, input)` next to `sendTaskMessage` at `:401`; wire `stopTaskSession`/`startTaskSession` to this API's own handlers)
- Modify: `src/trpc/app-router.ts:233,484` (`handOffTask` mutation, same pattern as `sendTaskMessage`)
- Modify: `src/commands/task.ts` (`task handoff --task-id <id> --message <text> [--project-path]`, same shape as `sendTaskMessage` at `:810` and `.command("send")` at `:1375`)
- Modify: `src/prompts/append-system-prompt.ts:311-318` (CLI reference entry for `task handoff`; "Reviewing tasks" steps 3–4)
- Test: `test/runtime/api-validation.test.ts`, `test/runtime/append-system-prompt.test.ts`, a CLI test next to `test/runtime/task-command-agent-id.test.ts`

**Interfaces:**
- Consumes: `handOffTask`, `HandOffTaskResult` from Task 1.
- Produces: `runtimeClient.runtime.handOffTask.mutate({ taskId, reason })` → `{ ok, error?, fromAgentId?, toAgentId? }`.

New "Reviewing tasks" steps 3–4 (exact):
```
3. If it fails and the round is below its cap (the number after the slash), use `task send --task-id <task_id> --message "<concrete fix list with file:line and failing command output>"`. Report what you sent in one chat line.
4. If it fails on round 3/3, run `task handoff --task-id <task_id> --message "<the same concrete fix list>"` and report it in one chat line. If handoff returns an error, or it fails on round 6/6, do not send another fix request: leave it in Review and report the reasons to the user in the chat.
```

- [x] **Step 1: Failing tests:** request schema rejects empty `reason`; CLI prints `{ ok: true, taskId, fromAgentId, toAgentId }` on success and exits non-zero with the error on `{ ok: false }` (Review Focus 3); system prompt contains `task handoff` and both new steps verbatim.
- [x] **Step 2:** run them → FAIL.
- [x] **Step 3:** implement the files above.
- [x] **Step 4:** `npm run typecheck && npm run test:fast && npm run lint` → PASS.

### Task 3: Crash trigger (codex)

**Files:**
- Modify: `src/server/sidebar-review-service.ts` (new dep `handOffTask: (taskId: string, reason: string) => Promise<{ ok: boolean; error?: string | null }>`; crash branch in `handleSummary`)
- Modify: `src/server/runtime-server.ts:193-204` (pass `handOffTask: (taskId, reason) => getInternalRuntimeApi().handOffTask(scope, { taskId, reason })`)
- Test: `test/runtime/server/sidebar-review-service.test.ts`

**Interfaces:**
- Consumes: `runtimeApi.handOffTask` from Task 2.

Crash = summary for a non-home task, previous state not crashed, and (`state === "failed"` or `reviewReason === "error"` or (`reviewReason === "exit"` and `exitCode !== 0`)). For a review-enabled, not handed-off, not trash card whose `agentId` is codex/opencode → call `deps.handOffTask(taskId, "The previous agent stopped with an error (exit code <n>).")`, do not queue a review; on `{ ok: false }` → `deps.warn` and fall through to today's behaviour.

- [x] **Step 1: Failing tests:** crash (`failed`) on codex review-enabled card → `handOffTask` called with the exact reason, sidebar not woken, `reviewRound` unchanged; crash with `exitCode: null` → reason ends `(exit code unknown).`; crash on `handedOff: true` card → no `handOffTask` (Review Focus 4); `exit` with code 0 → normal review path; review-off card → nothing.
- [x] **Step 2:** run → FAIL.
- [x] **Step 3:** implement.
- [x] **Step 4:** `npm run typecheck && npm run test:fast && npm run lint` → PASS.
