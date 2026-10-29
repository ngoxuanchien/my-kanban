# Agent Scoreboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score each task agent (+1 per passed sidebar review, −1 per failed one), count the tasks it was assigned, and show it as a strip on the top bar.

**Architecture:** An append-only event file `agent-scores.json` per workspace, owned by a small store module. The runtime and the CLI record events at the points where a review passes, fails, or a task session starts. The workspace state response carries derived totals; the top bar renders them.

**Tech Stack:** TypeScript, Node runtime (`src/`), React web UI (`web-ui/`), Vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-scoreboard-design.md`

## Global Constraints

- Points: `pass` +1, `fail` −1. `score = passes − fails`. `tasks` = distinct taskIds with an `assigned` event for that agent.
- De-dup: `assigned` once per `(agentId, taskId)`; `pass` once per `taskId`; `fail` once per `(taskId, round)`.
- A `pass`/`fail` whose `(agentId, taskId)` has no `assigned` event records `assigned` first.
- Agent id is always the card's `agentId` at the event; a card without `agentId` is never scored. The sidebar home session is never scored.
- Review-round card = `agentReviewEnabled === true`, column `review`, `reviewRound >= 1`. Only such cards score `pass`/`fail` (except the handoff `fail`, see Task 2).
- No points for quota/crash handoffs, quota retries, nudges, or UI drags.
- File: `<getWorkspaceDirectoryPath(workspaceId)>/agent-scores.json`, shape `{ "version": 1, "events": [{ "type", "agentId", "taskId", "round"?, "at" }] }`, every write through `lockedFileSystem` under a lock.
- Strip text format (exact): `codex +4 (6 task) · antigravity 0 (1 task) · opencode −3 (4 task)` — `+` for positives, `0` for zero, U+2212 `−` for negatives.
- No new dependencies. No `any`. No inline imports.
- Acceptance for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast`; Task 3 also `npm run web:typecheck` and `npm --prefix web-ui run test -- src/components/top-bar.test.tsx`.

## Review Focus

1. Two writers (CLI process and runtime) appending at once must not lose an event → store test with two concurrent `recordAgentScoreEvent` calls keeps both. Task 1.
2. A missing or corrupt `agent-scores.json` must never break `task done`, `task send`, starting a task, or loading the board → empty totals and a warning. Task 1.
3. `task done` (no flag) on a review-round card, and `task done --column review --review-passed`, must not score → Task 2 tests.
4. The same `task send` retried in the same round counts −1 once → Task 2 test.
5. The strip must not crowd out the top-bar controls when empty or narrow → hidden when there are no agents; test in Task 3.

## Kanban tasks and order

| Task | Agent | Depends on |
|---|---|---|
| 1. Scores store + `agentScores` in workspace state | opencode | — |
| 2. Record events (runtime + CLI) + sidebar prompt | antigravity | 1 |
| 3. Top-bar strip | codex | 1 |

Tasks 2 and 3 touch disjoint files and can run in parallel after Task 1.

---

### Task 1: Scores store and `agentScores` in workspace state

**Files:**
- Create: `src/state/agent-scores.ts`
- Modify: `src/core/api-contract.ts:325-334` (`runtimeWorkspaceStateResponseSchema`)
- Modify: `src/state/workspace-state.ts:655-661` (`loadWorkspaceState`) or `toWorkspaceStateResponse`
- Test: `test/runtime/state/agent-scores.test.ts`

**Interfaces:**
- Produces (in `src/core/api-contract.ts`):
  - `runtimeAgentScoreSchema = z.object({ agentId: z.string(), score: z.number().int(), passes: z.number().int().min(0), fails: z.number().int().min(0), tasks: z.number().int().min(0) })`, type `RuntimeAgentScore`.
  - `runtimeWorkspaceStateResponseSchema` gains `agentScores: z.array(runtimeAgentScoreSchema).optional()` (optional so existing CLI code that builds a state object still compiles).
- Produces (in `src/state/agent-scores.ts`):
  - `type AgentScoreEventType = "assigned" | "pass" | "fail"`
  - `recordAgentScoreEvent(workspaceId: string, event: { type: AgentScoreEventType; agentId: string; taskId: string; round?: number }, now?: () => number): Promise<boolean>` — appends under lock, applies de-dup and the auto-`assigned` rule, returns `true` if anything was appended.
  - `loadAgentScores(workspaceId: string): Promise<RuntimeAgentScore[]>` — derived totals, sorted by score desc then agentId asc; missing/corrupt file → `[]` (corrupt also `console.warn`), never throws.
  - `summarizeAgentScoreEvents(events: AgentScoreEvent[]): RuntimeAgentScore[]` — pure.

- [ ] **Step 1: Failing tests** in `test/runtime/state/agent-scores.test.ts` (point the runtime home at a temp dir the way existing state tests do):
  - `summarizeAgentScoreEvents` on: assigned codex/t1, fail codex/t1 r1, fail codex/t1 r2, assigned opencode/t1, pass opencode/t1 r3, assigned antigravity/t2 → `[{opencode, score 1, passes 1, fails 0, tasks 1}, {antigravity, 0, 0, 0, 1}, {codex, -2, 0, 2, 1}]`.
  - record `fail` codex/t1 round 1 twice → second returns `false`; one `fail` event, plus one auto `assigned`.
  - record `pass` for t1 twice → one `pass`.
  - record `assigned` codex/t1 twice → one event.
  - two concurrent `recordAgentScoreEvent` calls (different tasks) → both events on disk.
  - missing file → `loadAgentScores` returns `[]`; file containing `not json` → `[]` and no throw.
- [ ] **Step 2: Run** `npx vitest run test/runtime/state/agent-scores.test.ts` → FAIL.
- [ ] **Step 3: Implement** the store and add `agentScores: await loadAgentScores(context.workspaceId)` to the state returned by `loadWorkspaceState`. Write with `lockedFileSystem.writeJsonFileAtomic` inside `lockedFileSystem.withLock` using a file lock on `agent-scores.json`; the read-modify-write must be inside the same lock.
- [ ] **Step 4: Run** the test → PASS; then the acceptance commands.
- [ ] **Step 5: Commit** `feat(runtime): add agent score store and agentScores in workspace state`

---

### Task 2: Record events in the runtime and CLI; sidebar prompt

**Files:**
- Modify: `src/trpc/runtime-api.ts:185` (`startTaskSession`), `:404` (`sendTaskMessage`)
- Modify: `src/trpc/app-router.ts:498-503` (public `handOffTask` procedure)
- Modify: `src/commands/task.ts:1282-1300` (`task trash`/`done` options), `trashTask` (`:908`), add `task review-failed` command
- Modify: `src/prompts/append-system-prompt.ts:329-337`
- Test: `test/runtime/agent-score-recording.test.ts` (runtime-api), `test/runtime/task-command-agent-id.test.ts` (CLI), `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Consumes (Task 1): `recordAgentScoreEvent`, `loadAgentScores`.
- Produces: CLI `task done --task-id <id> --review-passed`; CLI `task review-failed --task-id <id> [--project-path <path>]` returning `{ ok: true, taskId, recorded: boolean }`.

Recording rules (look the card up in the board **before** the action changes it; skip if no `agentId`; after a `true` record call `broadcastRuntimeWorkspaceStateUpdated` in the runtime or `notifyRuntimeWorkspaceStateUpdated` in the CLI; a recording error is warned and never fails the command):
- `startTaskSession`: after a successful start, `assigned` for the card's `agentId` (read the card after the start).
- `sendTaskMessage`: after a successful send to a review-round card, `fail` with `round = card.reviewRound`.
- public tRPC `handOffTask` procedure: when the result is `ok: true`, `fail` for `result.fromAgentId` with the card's `reviewRound` read before the call. Do **not** record inside `runtimeApi.handOffTask` or `handOffTask()`: internal crash/quota/retry handoffs must not score.
- `task done --review-passed`: only with `--task-id` (with `--column` → error `--review-passed requires --task-id`); if the card is a review-round card, record `pass` with `round = card.reviewRound` before `completeTaskToDone` moves it. Without the flag nothing is recorded.
- `task review-failed --task-id`: if the card is a review-round card, record `fail` with `round = card.reviewRound`; otherwise `recorded: false`. Does not move or message the task.

- [ ] **Step 1: Failing tests**
  - runtime: `startTaskSession` twice for a codex card → one `assigned`; card without `agentId` → none.
  - runtime: `sendTaskMessage` on a review-round codex card, round 2 → one `fail` round 2; sent twice → still one; on a card in `in_progress` or with review off → none.
  - tRPC procedure: `handOffTask` returning ok from `codex` → `fail` for codex; returning `{ ok: false }` → none. Direct `runtimeApi.retryQuotaBlockedTask` → none.
  - CLI: `task done --task-id t1 --review-passed` on a review-round card → one `pass`; `task done --task-id t1` → none; `task done --column review --review-passed` → error; `task review-failed --task-id t1` → `recorded: true`, then again → `recorded: false`.
  - Prompt: step 2 contains `task done --task-id <task_id> --review-passed`; step 4 contains `task review-failed --task-id <task_id>` for the round-equals-cap case and the handoff-error case.
- [ ] **Step 2: Run** the three test files → FAIL.
- [ ] **Step 3: Implement** the rules above. Prompt edits: in step 2 replace `task done --task-id <task_id>` with `task done --task-id <task_id> --review-passed`; in step 4 add "run `task review-failed --task-id <task_id>`" before reporting, in both the handoff-error case and the round-equals-cap case. Add `task review-failed` and the `--review-passed` flag to the CLI reference section of the same prompt.
- [ ] **Step 4: Run** the tests → PASS; then the acceptance commands.
- [ ] **Step 5: Commit** `feat(runtime): record agent score events for reviews and task starts`

---

### Task 3: Top-bar score strip

**Files:**
- Modify: `web-ui/src/components/top-bar.tsx` (project view row around `:410-520`), plus the place that passes workspace state into `TopBar`
- Modify: the web-ui type for the workspace state if it does not come straight from `RuntimeWorkspaceStateResponse`
- Test: `web-ui/src/components/top-bar.test.tsx`

**Interfaces:**
- Consumes (Task 1): `RuntimeWorkspaceStateResponse.agentScores?: RuntimeAgentScore[]`.
- Produces: `TopBar` prop `agentScores?: RuntimeAgentScore[]`.

- [ ] **Step 1: Failing tests** in `top-bar.test.tsx`:
  - `agentScores = [{codex, 4, 6, 2, 6}, {antigravity, 0, 0, 0, 1}, {opencode, -3, 1, 4, 4}]` → strip text `codex +4 (6 task) · antigravity 0 (1 task) · opencode −3 (4 task)`.
  - score classes: `+4` has `text-status-green`, `0` has `text-text-secondary`, `−3` has `text-status-red`.
  - `agentScores` empty or undefined → no strip element.
  - tooltip content for codex contains `6 pass`, `2 fail`, `6 task`.
- [ ] **Step 2: Run** `npm --prefix web-ui run test -- src/components/top-bar.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the strip in the existing right-side flex row; render in the order given (already sorted by the runtime). Use `Tooltip` from `@/components/ui/tooltip`, Tailwind tokens only. Hide it below the `md` breakpoint (`hidden md:flex`) so it never pushes the existing controls. Wire `agentScores` from the workspace state into `TopBar`.
- [ ] **Step 4: Run** the test → PASS; then `npm run web:typecheck`, `npm run lint`, `npm run test:fast`.
- [ ] **Step 5: Commit** `feat(web-ui): show agent scores on the top bar`

---

## After all tasks
- Record in `contexte/memory-orchestrator.md`: scoring rules (+1/−1), `agent-scores.json` location, commit hashes, and that Kanban.app needs a rebuild before the sidebar prompt and CLI flags are live.
