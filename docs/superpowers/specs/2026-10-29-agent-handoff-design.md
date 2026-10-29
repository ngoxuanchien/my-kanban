# Agent handoff — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-sidebar-agent-review-design.md`, `2026-10-29-empty-task-nudge-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Intent

The project goal says the orchestrator "picks the model". The user's actual need is simpler: **"I don't care which agent, it just has to get done."** **[user]** So this is not a router that guesses which model suits a task. When the agent on a task gets stuck, Kanban hands the task to the other agent automatically. The user is only pulled in when both agents have failed.

## 2. Goals, non-goals, anti-goals

### Goals
- G1. Stuck task on Codex → continues on OpenCode, and the other way round. Pool: `codex` ↔ `opencode` only. **[assistant's call, matches the 2026-10-28 "no fallback to Claude" decision]**
- G2. The second agent **continues on the first agent's work**: same worktree, same branch, uncommitted changes kept. **[user]**
- G3. Triggers:
  - review failed on round 3 (the current 3 rounds are kept unchanged) **[user]**;
  - the agent session crashed or exited with an error: session state `failed`, or `reviewReason` `"error"`, or `"exit"` with a non-zero exit code. Handoff happens immediately, without using a review round. **[assistant's call]**
- G4. At most one handoff per task. The second agent gets review rounds 4–6, so **6 rounds in total**. **[user]** If round 6 fails, the task stays in Review and the sidebar reports to the user, as round 3 does today.
- G5. Only for tasks with `agentReviewEnabled` on; review-off tasks keep upstream behaviour. **[assistant's call]**

### Non-goals
- Picking an agent up front from the task's content, cost or history. The planner keeps alternating `--agent-id` as today.
- Detecting quota/usage-limit text in the agent's terminal output. A quota error that makes the agent exit is caught by the crash trigger. A quota message that leaves the agent idle ends the turn with an empty worktree, which hits the empty-task nudge and then review rounds. **[assistant's call: output text differs per agent and version, too fragile for v1]**
- Handing off to Claude or Cline.
- Metrics or reports (2026-10-28 user decision).

### Anti-goals
- The second agent starts from a clean worktree or throws away the first agent's changes.
- A task bounces between agents more than once.
- A review-off task is touched.

## 3. How it works

### 3.1 State on the card
Add `handedOff?: boolean` to the board card (same places `agentReviewEnabled` and `reviewRound` live: `src/core/api-contract.ts`, `web-ui/src/types/board.ts`, board state helpers). The card's `agentId` is changed to the new agent, so the board shows who is working on the task now.

### 3.2 Runtime handoff action
One runtime function `handOffTask(taskId, reason)` (new file under `src/server/`, used by the CLI and by the sidebar review service):
1. Refuse if the card has `agentReviewEnabled` off, `handedOff` already true, or an `agentId` that is not `codex`/`opencode`.
2. Stop the current task session (existing stop path).
3. Set `agentId` to the other agent and `handedOff: true`; keep `reviewRound` as is (3 after a review failure, or the current value after a crash).
4. Start a new session in the **existing** worktree (existing `startTaskSession` with the new `agentId`; do not recreate the worktree) with this prompt:

```
<original task prompt>

---
[Kanban handoff] Another agent (<old agent>) worked on this task before you and could not finish it.
Its unfinished work is already in this worktree (uncommitted changes and commits since <baseRef>). Check it and continue from it; do not start over.
Why it was handed off: <reason>
```

`<reason>` is the last review fix list (review trigger), or `The previous agent stopped with an error (exit code <n>).` (crash trigger).

5. Move the card to `in_progress` and broadcast the state update.

### 3.3 Triggers
- **Review trigger:** new CLI command `task handoff --task-id <id> --message "<fix list>"` that calls `handOffTask`. The sidebar instructions in `src/prompts/append-system-prompt.ts` ("Reviewing tasks", step 4) change to: on a failed round 3, if the task is not handed off, run `task handoff` with the concrete fix list and report it in one chat line; on a failed round 6 (or round 3 when handoff is refused), leave it in Review and report to the user.
- **Crash trigger:** in `src/server/sidebar-review-service.ts` `handleSummary`, for a review-enabled, not handed-off task whose summary moves to a crash state (G3), call `handOffTask` instead of queuing a review.

### 3.4 Round limit
`src/server/sidebar-review-queue.ts` uses 3 as the cap and prints `round n/3`. Make the cap `handedOff ? 6 : 3`, and print the same cap in the wake-up message. `start()` restore logic and `notifyBoardChanged` reset (`reviewRound: 0`) also reset `handedOff` to `false` under the same condition as `reviewRound` (card in trash or review turned off). Do not reset it when the card moves to `in_progress`: a handed-off task does exactly that.

## 4. Risks
- Codex Free quota may run out on both sides of a pair of tasks. Then a task stops after its single handoff; the user sees it in Review.
- The second agent may redo the work instead of continuing. The prompt says not to; the sidebar review catches it.
- Stopping a session while the agent is still writing: the triggers only fire after a turn end or exit, so the session is already idle.

## 5. Tests
- Queue: cap 6 when `handedOff`, wake-up text `round 4/6`.
- `handOffTask`: switches codex→opencode and opencode→codex; refuses on second handoff, on review-off tasks, on `claude`; keeps the worktree (does not call worktree create/reset); prompt contains the original prompt, the old agent and the reason.
- Sidebar review service: crash summary on a review-enabled task → `handOffTask` called, no review queued; crash after handoff → no second handoff.
- CLI `task handoff` argument parsing and error output.

## 6. Left to the builder
- Exact stop/start calls in the runtime for an existing worktree. **[builder]**
- Where `handedOff` is surfaced in the UI; a small badge on the card is enough, or nothing. **[builder]**
