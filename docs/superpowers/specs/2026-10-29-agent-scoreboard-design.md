# Agent scoreboard — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-sidebar-agent-review-design.md`, `2026-10-29-agent-handoff-design.md`, `2026-10-29-quota-retry-and-review-notes-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Why

The user splits implementation between codex, opencode and antigravity to learn which one does better work (`contexte/memory-orchestrator.md`). Today the only evidence is reading old cards. A small, always-visible score per agent answers "which agent is better" at a glance. **[user]**

This is a deliberate exception to the 2026-10-28 decision "no metrics report or script": it is one line on the board, not a report.

## 2. Goals, non-goals, anti-goals

### Goals
- G1. Score per agent: **+1** for every sidebar review that passes, **−1** for every sidebar review that fails, including a failed last round where nothing is sent. **[user, revised 2026-10-29: −1, not −2]**
- G2. No points for quota handoffs **[user]**, crash handoffs, empty-task nudges, or hourly quota retries. **[assistant's call]**
- G3. Every agent that has been assigned at least one task appears, even at 0 points, with its **number of assigned tasks**. **[user]**
- G4. Shown as an always-visible strip on the top bar (mockup option B). **[user]**

### Non-goals
- Using scores to pick or route agents. **[user]** ("chỉ xem cho biết agent nào tốt hơn")
- Time windows, rankings over periods, a reset button, a separate report page. **[assistant's call]**
- Scoring tasks without agent review, or cards moved by hand in the UI.

### Anti-goals
- A point counted for an event the agent did not cause (quota, crash, the user dragging a card).
- The same event counted twice (for example a retried CLI call, or a UI save racing a runtime save).
- Scores lost when a task is deleted or its worktree removed.

## 3. Scoring rules

The agent credited is the card's `agentId` at the moment of the event (the agent holding the task). **[assistant's call]** Example: codex fails 3 rounds (−3), the task is handed off, opencode passes first time (+1) → codex −3, opencode +1.

| Event | Where it is seen | Points |
|---|---|---|
| Pass: sidebar runs `task done --task-id <id> --review-passed` on a card with `agentReviewEnabled === true`, in the `review` column, `reviewRound >= 1` | the CLI `task done` command handler (`src/commands/task.ts:1282-1283`, single-task form only), not `completeTaskToDone` | +1 |
| Fail: `task send` on a card with `agentReviewEnabled === true`, in the `review` column, `reviewRound >= 1` | runtime `sendTaskMessage` (`src/trpc/runtime-api.ts:404`) | −1 |
| Fail + handoff: sidebar runs `task handoff` after a failed round and it returns `ok: true` | the public tRPC handoff procedure (`src/trpc/app-router.ts:498`), not the internal crash/quota/retry paths | −1, to the agent handed **from** |
| Final fail: the round equals the cap, or `task handoff` was refused; sidebar runs `task review-failed --task-id <id>` | new CLI command `task review-failed`, single task only | −1 |
| Quota handoff, crash handoff, hourly quota retry, empty-task nudge | sidebar review service | 0 |
| Card dragged to Done in the UI | board save | 0 |

**[assistant's call]** `task done` is an alias of `task trash` (`src/commands/task.ts:1282-1283`), so a plain `task done`/`task trash` cannot tell a pass from a discard. Add a `--review-passed` flag, valid only with `--task-id` (error with `--column`), and change step 2 of the sidebar review prompt (`src/prompts/append-system-prompt.ts:329-337`) to use it. Without the flag nothing is scored. The flag is read in the CLI command handler; `completeTaskToDone` stays unchanged.

**[assistant's call]** `task send` has no such flag; a user who types `task send` by hand on a review-round card is counted as a fail. That is acceptable.

**[assistant's call]** The internal crash/quota handoffs call the same runtime `handOffTask` (`src/trpc/runtime-api.ts:438`) as the CLI. Record the handoff −1 in the public tRPC procedure handler, not inside `handOffTask`, so internal handoffs never score.

## 4. Assigned tasks

An agent counts a task as assigned when a session for that task **starts** with that agent: first start, auto-start of a linked task, handoff, or quota retry. Each `(agent, taskId)` pair counts once. A task created but never started counts for nobody. **[assistant's call]** Hook: runtime `startTaskSession` (`src/trpc/runtime-api.ts:185`), which every start path goes through; restarts of the same task with the same agent are de-duplicated by the pair. Record the card's `agentId` after the start (handoff/retry set it before starting), not `startTaskSession`'s internally resolved `effectiveAgentId`; skip if the card has no `agentId` (§5).

## 5. Storage

- One file per workspace next to `board.json`: `~/.cline/kanban/workspaces/<workspaceId>/agent-scores.json`, written through `lockedFileSystem` like the other state files (`src/state/workspace-state.ts:20-30`). **[assistant's call]** Separate from `board.json` so deleting a task never loses its score, and so UI board saves cannot overwrite it.
- Content: an append-only list of events, nothing derived. **[assistant's call]**
  ```json
  { "version": 1, "events": [
    { "type": "assigned", "agentId": "codex", "taskId": "742a9", "at": 1793280561290 },
    { "type": "fail", "agentId": "codex", "taskId": "742a9", "round": 1, "at": 1793281000000 },
    { "type": "pass", "agentId": "opencode", "taskId": "742a9", "round": 4, "at": 1793282000000 }
  ] }
  ```
  `type` is `assigned | pass | fail`; `round` is the card's `reviewRound` at the event (absent for `assigned`).
- De-duplication: `assigned` once per `(agentId, taskId)`; `pass` once per `taskId`; `fail` once per `(taskId, round)`, so a `task handoff` followed by `task review-failed` in the same round still counts −1 once. **[assistant's call]** This makes a retried CLI call harmless.
- Totals are derived on read: `score = passes − fails`, `tasks = distinct taskIds with an assigned event`.
- Task agents only: the sidebar's home agent session is never recorded. **[assistant's call]**
- Agent id: every event (`assigned`, `pass`, `fail`) uses the card's `agentId` at that moment. A card without `agentId` is not scored at all, so no points go to an "undefined" agent. The strip shows every agent id that has events, not only codex/opencode/antigravity. **[assistant's call]**
- Tasks started before this ships have no `assigned` event. When a `pass` or `fail` is recorded and the `(agentId, taskId)` pair has no `assigned` event, record the `assigned` event first. No backfill step. **[assistant's call]**

## 6. Getting the scores to the UI

Add `agentScores` to the workspace state the UI already receives (`runtimeWorkspaceStateResponseSchema`, `src/core/api-contract.ts:325`): an array of `{ agentId: string; score: number; passes: number; fails: number; tasks: number }`. Broadcast a workspace state update after each recorded event (the CLI `task done` path already calls `notifyRuntimeWorkspaceStateUpdated`). **[assistant's call]** The UI never writes this field back.

## 7. Display (top bar, option B)

In `web-ui/src/components/top-bar.tsx`, on the project view, a compact strip:

`codex +4 (6 task) · antigravity 0 (1 task) · opencode −3 (4 task)` **[user]**

- Positive score `text-status-green`, negative `text-status-red`, zero `text-text-secondary`; agent names and task counts `text-text-secondary`. **[assistant's call]**
- Sorted by score, highest first; ties by agent id. **[assistant's call]**
- Hover tooltip (`Tooltip` from `@/components/ui/tooltip`) with `passes`, `fails`, `tasks` per agent. **[assistant's call]**
- Hidden when no agent has an `assigned` event. On narrow widths it must not push existing top-bar controls; the builder picks the breakpoint. **[builder]**

## 8. Tests

- Scores store: append + de-dup rules (§5); totals; missing file → empty; corrupt file → empty + warn, never throws into the caller.
- Runtime: `sendTaskMessage` on a review-round card → one `fail` for the card's agent; on a non-review card or a card with review off → nothing. `startTaskSession` → one `assigned`; a second start with the same agent → still one. Public tRPC handoff with `ok: true` → `fail` for the from-agent; refused → nothing; internal crash/quota/retry handoff → no `fail`. `task review-failed` on a review-round card → one `fail`; same round again → still one.
- `task done --task-id <id> --review-passed` on a review-round, review-enabled card → one `pass`; without the flag, on a backlog card, or with review off → nothing; `--review-passed` with `--column` → error.
- `pass`/`fail` for a pair with no `assigned` event → `assigned` recorded first; card without `agentId` → nothing recorded.
- Sidebar prompt step 2 uses `task done --task-id <task_id> --review-passed`; step 4 runs `task review-failed --task-id <task_id>` when the round equals the cap or `task handoff` returns an error.
- State response includes `agentScores` with correct totals.
- `top-bar.test.tsx`: strip text and order for sample scores; hidden when empty; colours by sign.

Acceptance: `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast`, web-ui tests for `top-bar`.

## 9. Left to the builder
- Module layout for the scores store (one small file under `src/state/` is expected). **[builder]**
- How the CLI process and the runtime both write safely: both must go through `lockedFileSystem`. **[builder]**
- Narrow-width behaviour of the strip (§7). **[builder]**
- After shipping: note in `contexte/memory-orchestrator.md` that scoring is live and the app needs a rebuild.
