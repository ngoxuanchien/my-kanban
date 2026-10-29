# Sidebar Agent Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Kanban sidebar agent reviews finished tasks that opted in, sends up to 3 rounds of fixes through a new `task send` command, and commits + moves passing tasks to Done.

**Architecture:** Task 1 adds the card fields, the `task send` CLI/tRPC path and a reusable PTY prompt sender. Task 2 adds a per-workspace runtime service that watches task turn ends, counts rounds, and wakes the idle sidebar session with one `[Kanban review]` line; it also teaches the sidebar prompt how to review. Task 3 adds the web-ui toggle and stops auto-commit for opted-in tasks.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), zod, tRPC, commander, vitest, React + Tailwind v4 (`web-ui`).

**Spec:** `docs/superpowers/specs/2026-10-29-sidebar-agent-review-design.md`

## How to run this plan on the board

| Task | `--agent-id` | Depends on | Parallel with |
|---|---|---|---|
| 1. Card fields + `task send` | `opencode` | — | — |
| 2. Review queue + sidebar wake-up + sidebar prompt | `codex` | 1 (merged) | 3 |
| 3. Web-ui toggle | `opencode` | 1 (merged) | 2 |

- File ownership: Task 1 owns `src/core/api-contract.ts`, `src/commands/task.ts`, `man/kanban.1`, `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`, `src/terminal/send-prompt-to-session.ts` and their tests. Task 2 owns `src/server/sidebar-review-*.ts`, `src/server/runtime-server.ts`, `src/prompts/append-system-prompt.ts` and their tests. Task 3 owns `web-ui/src/**`.
- Tasks are created without agent review (the feature does not exist yet); the sidebar agent reviews them by hand when the user asks.

## Global Constraints

- Max review rounds: **3**. Wake-up text, exactly: `[Kanban review] Task <id> "<title>" is in Review, round <n>/3. Review it now.`
- `agentReviewEnabled` default `false`; `reviewRound` default `0`; both optional in the saved board so old boards load unchanged.
- Never interrupt the user: write into the sidebar PTY only while its session summary `state` is `"awaiting_review"` or `"idle"` with a live process, never while `"running"`.
- Sidebar session id: `createHomeAgentSessionId(workspaceId, agentId)` from `src/core/home-agent-session.ts`.
- Git: never push. No PR mode.
- Before claiming done: `npm run typecheck`, `npm run lint`, `npx biome check --staged` (formatting — `lint` does not check it; the pre-commit hook does), `npm run test:fast`; Task 3 also `npm run web:typecheck` and `npm run web:test`.

## Review Focus

1. A task with `agentReviewEnabled: false` never produces a wake-up. Test: Task 2, Step 1.
2. A turn end while the sidebar is `running` is queued and delivered only after the sidebar's own turn ends. Test: Task 2, Step 1.
3. Round 4 is never queued (user sent a manual fix after round 3). Test: Task 2, Step 1.
4. `task send` to a task with no live session returns `{ ok: false }` with a clear error and exit code 1, not a crash. Test: Task 1, Step 1.
5. Two tasks finishing together produce two separate wake-ups, one per sidebar idle period, not one merged line. Test: Task 2, Step 1.

---

### Task 1: Card fields and `task send`

**Files:**
- Modify: `src/core/api-contract.ts:132-149` (`runtimeBoardCardSchema`), plus request/response schemas for the new route
- Create: `src/terminal/send-prompt-to-session.ts`
- Modify: `src/trpc/runtime-api.ts`, `src/trpc/app-router.ts:470` (next to `sendTaskSessionInput`)
- Modify: `src/commands/task.ts` (new `send` subcommand after `start` at `:1280`; `--agent-review-enabled` on `create`/`update`; list output), `man/kanban.1`
- Test: `test/runtime/terminal/send-prompt-to-session.test.ts`, `test/runtime/trpc/runtime-api.test.ts`, `test/runtime/api-validation.test.ts`, `test/integration/cli-compat.integration.test.ts`

**Interfaces:**
- Produces: card fields `agentReviewEnabled?: boolean`, `reviewRound?: number` (int ≥ 0).
- Produces: `sendPromptToSession(input: { sessionId: string; prompt: string; agentId: RuntimeAgentId | null; terminalManager: TerminalSessionManager; clineService: ClineTaskSessionService; sleep?: (ms: number) => Promise<void> }): Promise<{ ok: true } | { ok: false; reason: "session_not_running" }>` — restore the logic of the deleted `src/agent-review/send-prompt-to-task.ts` (`git show 9875de30:src/agent-review/send-prompt-to-task.ts`: Cline → `sendTaskSessionInput(…, "act")`; PTY → bracketed paste `\x1b[200~…\x1b[201~`, wait 200 ms, then `\r`). Task 2 uses it for the sidebar.
- Produces: tRPC `runtime.sendTaskMessage` (workspace procedure) `{ taskId: string; message: string } → { ok: boolean; error?: string }`.
- Produces: CLI `task send --task-id <id> --message <text> [--project-path <path>]`, JSON output `{ ok, taskId }` or `{ ok: false, error }` with exit code 1.
- Produces: `task list` items include `agentReviewEnabled`, `reviewRound`, `baseRef`, `worktreePath`.

- [x] **Step 1: Write the failing tests**
  - `send-prompt-to-session.test.ts`: PTY path writes `\x1b[200~fix it\x1b[201~` then `\r` (fake `terminalManager.writeInput` records buffers, fake `sleep`); returns `{ ok: false, reason: "session_not_running" }` when `writeInput` returns `null`; Cline path calls `sendTaskSessionInput(id, prompt, "act")`.
  - `runtime-api.test.ts`: `sendTaskMessage` for an unknown task → `{ ok: false, error: expect.stringContaining("not running") }`.
  - `api-validation.test.ts`: a card without the new fields parses with them absent; a card with `agentReviewEnabled: true, reviewRound: 2` keeps both.
  - `cli-compat.integration.test.ts`: `task send --help` lists `--task-id` and `--message`; `task create --agent-review-enabled true` stores the field.
- [x] **Step 2: Run and confirm they fail** — `npx vitest run test/runtime/terminal/send-prompt-to-session.test.ts test/runtime/trpc/runtime-api.test.ts test/runtime/api-validation.test.ts`. Expected: FAIL (module / route / field missing).
- [x] **Step 3: Implement** the interfaces above. `sendTaskMessage` resolves the task's agent from its card (`card.agentId ?? config.selectedAgentId`). OpenCode v2 caveat from commit 33669791: a prompt can land in the terminal without starting a turn — out of scope here; just document it in a code comment. Spec §4.1 "Review → In Progress after a send": first check whether the existing session-state handling already moves the card when the agent starts running again; only if it does not, move the card to `in_progress` in `sendTaskMessage` through the existing workspace-state mutation path, and add a `runtime-api.test.ts` case for it.
- [x] **Step 4: Run and confirm they pass** (same command) and `npx vitest run test/integration/cli-compat.integration.test.ts`.
- [x] **Step 5: Full checks** — `npm run typecheck && npm run lint && npm run test:fast`, all exit 0.

---

### Task 2: Review queue, sidebar wake-up, sidebar prompt

**Files:**
- Create: `src/server/sidebar-review-queue.ts` (pure state: rounds + queue), `src/server/sidebar-review-service.ts` (wiring: summaries in, wake-ups out)
- Modify: `src/server/runtime-server.ts` (create one service per workspace like the deleted agent-review registry did — see `git show de8af43f -- src/server/runtime-server.ts`; dispose on shutdown)
- Modify: `src/prompts/append-system-prompt.ts` (new "Reviewing tasks" section + `task send` in the CLI reference; relax the rule at `:140`/`:158` only for git commit / cherry-pick / stash of a passed review)
- Test: `test/runtime/server/sidebar-review-queue.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, `test/runtime/prompts/append-system-prompt.test.ts` (create if missing)

**Interfaces:**
- Consumes: Task 1 card fields and `sendPromptToSession`.
- Produces: `createSidebarReviewQueue()` returning `{ onTaskTurnEnd(card: { id: string; title: string; agentReviewEnabled?: boolean; reviewRound?: number }): { round: number } | null; onSidebarIdle(): string | null; onTaskDone(taskId: string): void; size(): number }`. `onTaskTurnEnd` returns the new round (caller persists it as `reviewRound`) or `null` when not queued; `onSidebarIdle` returns the next wake-up line or `null`.
- Turn end = task session summary moves to `state: "awaiting_review"` with `reviewReason` `"hook"` or `"exit"` with exit code 0 (the deleted `classifyTurnEnd` in `git show 9875de30:src/agent-review/task-session-signals.ts` is the reference; skip `"attention"`). Home-agent sessions (`isHomeAgentSessionId`) are never tasks.
- Sidebar idle = the home session summary is in `"awaiting_review"` or `"idle"` and its process is alive. Deliver at most one line per idle period; the next one waits for the following idle transition.
- Reset `reviewRound` to 0 when the card goes to trash/Done or `agentReviewEnabled` is set false.
- Restart: on service start, every card in `review` with `agentReviewEnabled` and `reviewRound` in 1..3 is queued again with its current round (no increment).

- [x] **Step 1: Write the failing tests** for `sidebar-review-queue.test.ts`:
  - `"ignores tasks with review off"`: `onTaskTurnEnd({ id: "a", title: "A" })` → `null`; `onSidebarIdle()` → `null`.
  - `"queues round 1 and formats the wake-up line"`: `onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true, reviewRound: 0 })` → `{ round: 1 }`; `onSidebarIdle()` → `'[Kanban review] Task a "A" is in Review, round 1/3. Review it now.'`.
  - `"never queues round 4"`: `reviewRound: 3` → `null`.
  - `"one task per idle period"`: two tasks queued; first `onSidebarIdle()` → task a line, second → task b line, third → `null`.
  - `"done clears a queued task"`: queue a, `onTaskDone("a")`, `onSidebarIdle()` → `null`.
  - In `sidebar-review-service.test.ts` (fake terminal manager emitting summaries): a task turn end while the sidebar summary is `running` sends nothing; when the sidebar summary turns `awaiting_review`, exactly one `sendPromptToSession` call with the sidebar session id.
- [x] **Step 2: Run and confirm they fail** — `npx vitest run test/runtime/server/sidebar-review-queue.test.ts test/runtime/server/sidebar-review-service.test.ts`.
- [x] **Step 3: Implement** the queue (pure, no timers), then the service and its wiring in `runtime-server.ts`, persisting `reviewRound` through the existing workspace-state mutation path and broadcasting the state update.
- [x] **Step 4: Prompt section** in `append-system-prompt.ts`: the four review steps from spec §4.4 (read prompt + diff, run checks, pass → commit per `DEFAULT_COMMIT_PROMPT_TEMPLATE` steps then `task done`, fail < 3 → `task send` fix list, fail at 3 → report to user). Test: the generated prompt contains `"[Kanban review]"` and `"task send"`.
- [x] **Step 5: Run and confirm they pass**, then `npm run typecheck && npm run lint && npm run test:fast`, all exit 0.

---

### Task 3: Web-ui toggle

**Files:**
- Modify: `web-ui/src/components/task-create-dialog.tsx`, `web-ui/src/components/task-inline-create-card.tsx`, `web-ui/src/hooks/use-task-editor.ts`, `web-ui/src/hooks/use-review-auto-actions.ts`, `web-ui/src/state/board-state.ts`
- Test: `web-ui/src/hooks/use-task-editor.test.tsx`, `web-ui/src/hooks/use-review-auto-actions.test.tsx`

**Interfaces:**
- Consumes: Task 1 card field `agentReviewEnabled?: boolean`. Look at the deleted toggle in `git show 449f93b0 -- web-ui/src/components/task-create-dialog.tsx web-ui/src/hooks/use-task-editor.ts` for the earlier layout; reuse it.

- [x] **Step 1: Write the failing tests**
  - `use-task-editor.test.tsx`: `"creates a task with agentReviewEnabled when the toggle is on"` → the created card has `agentReviewEnabled: true`; default is `false`.
  - `use-review-auto-actions.test.tsx`: `"skips auto-commit for agent-reviewed tasks"` → a review card with `autoReviewEnabled: true, agentReviewEnabled: true` triggers no commit action.
- [x] **Step 2: Run and confirm they fail** — `npm --prefix web-ui run test -- use-task-editor use-review-auto-actions`.
- [x] **Step 3: Implement** a checkbox/switch labelled **"Agent review (sidebar agent reviews and commits)"** in the create dialog and inline create card; when it is on, the auto-review controls are disabled.
- [x] **Step 4: Run and confirm they pass**, then `npm run web:typecheck && npm run web:test && npm run lint`, all exit 0.
