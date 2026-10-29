# Done task history — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-agent-scoreboard-design.md`, `2026-10-29-sidebar-agent-review-design.md`, `2026-10-29-agent-handoff-design.md`, `2026-10-29-quota-retry-and-review-notes-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Why

Done cards stay on the board but cannot be clicked (`web-ui/src/components/board-card.tsx:281-282`: `isCardInteractive = !isTrashCard`). The user wants to look back at a finished task and see **which agent did it, how many review rounds failed and why**, and **what changed**. **[user]** The user does not ask agents to redo finished tasks, so this is read-only. **[user]**

Today the reasons are lost: the review fix list sent with `task send` goes straight into the agent terminal; `agent-scores.json` stores agent, round and pass/fail but no reason; the worktree and session are deleted when a task is done. The cherry-picked commit on `main` survives. **[user observation, confirmed]**

## 2. Goals, non-goals, anti-goals

### Goals
- G1. Clicking a Done card opens a **read-only detail view** (mockup option C): back button, task prompt on the left, history on the right. **[user]**
- G2. The history is a timeline: task started (agent), each review fail with the **full** fix list, each handoff with its reason (review cap, quota, crash), quota blocked, quota retry, and the pass with its commit. **[user]**
- G3. Below the timeline: the **changed files and diff** of the passing commit on `main`. **[user]**
- G4. A **"View agent session"** button per agent run that shows the agent's own saved transcript **read-only inside Kanban** (mockup option C, transcript viewer chosen as option A on 2026-10-29). No agent process is started. **[user]**
- G5. Done tasks from before this ships show their prompt and "No history recorded for this task." **[user accepted]**

### Non-goals
- Storing terminal output in Kanban (agents already keep their own transcripts; G4 covers it). **[assistant's call, user agreed]**
- Reopening / restarting a Done task from this view, and launching any agent CLI (including resume). **[user]**
- Backfilling history for old tasks. **[user accepted]**
- Making Done cards draggable or changing the existing restore-from-trash behaviour (`web-ui/src/hooks/use-board-interactions.ts:570`).

### Anti-goals
- Any button in this view that starts, resumes-to-work, commits, or moves the task.
- A history that changes scores, or a task deletion that removes score events.
- Losing the history when a task is moved to Done or its worktree is removed (only a permanent delete removes it).

## 3. Data: one history file per task

**[user, 2026-10-29]** History lives in its own files, not in `agent-scores.json`, and deleting a task from the board deletes its history. Scores are not touched by deletion (scoreboard spec: scores survive task deletion).

- File: `<getWorkspaceDirectoryPath(workspaceId)>/task-history/<taskId>.json`, shape `{ "version": 1, "events": TaskHistoryEvent[] }`, written through `lockedFileSystem` under a file lock. **[assistant's call]** One file per task makes deletion a single file removal.
- `TaskHistoryEvent = { type: "started" | "fail" | "handoff" | "quota_blocked" | "retry" | "pass" | "session"; agentId: string; at: number; round?: number; detail?: string; commit?: string; toAgentId?: string; agentSession?: { agentId: string; id?: string; transcriptPath?: string } }`.
- `agent-scores.json` and its scoring/de-dup rules stay exactly as they are; recording points write the score event (unchanged) **and** the history event.
- De-dup in history: `started` once per (agentId) per run is not needed — record every start; `fail` once per round (a later `fail` for the same round with `detail` fills a missing detail); `pass` once; `session` once per `agentSession.id`; others only drop an identical event within 5,000 ms. **[assistant's call]**
- `detail` is capped at 20,000 characters (truncate with "… (truncated)"). **[assistant's call]**
- Deletion: every path that permanently deletes a task (CLI `task delete --task-id` / `--column`, and the UI delete/clear of Done cards, whichever runtime function they share) removes `task-history/<taskId>.json`. Moving a task to Done does **not** delete history. A missing file is not an error. **[user]**
- Read function `loadTaskHistory(workspaceId, taskId): Promise<TaskHistoryEvent[]>` sorted by `at`; missing/corrupt file → `[]`.

## 4. Where each history event comes from

| Event | Source | Fields |
|---|---|---|
| started | `startTaskSession` (next to the existing `assigned` score event) | agentId, at |
| review fail | `task send` to a review-round card (runtime `sendTaskMessage`) | `detail` = the message text |
| review fail, last round | `task review-failed --task-id <id> --message "<fix list>"` (new `--message`) | `detail` |
| handoff (review) | public tRPC `handOffTask` | `fail` (existing) + `handoff` with `detail` = the `--message`, `toAgentId` |
| handoff (quota / crash) | `src/server/sidebar-review-service.ts` before `deps.handOffTask` | `handoff` with the runtime reason text, no score |
| quota blocked | quota branch that sets `quotaBlockedAt` | `quota_blocked` |
| retry | hourly retry path (`retryQuotaBlockedTask`) | `retry` with the new agent |
| pass | `task done --task-id <id> --review-passed --commit <hash>` (new `--commit`) | `commit` |

Sidebar prompt (`src/prompts/append-system-prompt.ts`, "Reviewing tasks"): step 2 passes `--commit <hash of the cherry-picked commit on the base branch>`; step 4 passes `--message "<the same fix list>"` to `task review-failed`. **[assistant's call]** Use the base-branch hash, not the worktree hash: the worktree commit may be garbage-collected after the worktree is removed.

## 5. Agent session ids (for G4)

At each turn end the runtime appends a `session` history event, once per `(task, agent, session id)`, carrying `agentSession` (the agent's own session/conversation id and transcript path). **[assistant's call]** A separate event is needed because the session id is only known at turn end; a chain codex → opencode → codex yields two codex `session` events, one per run. The timeline groups events into runs by these `session` events. **[builder]** must find where each adapter exposes it:
- Antigravity: the Stop hook payload already has `conversationId` and `transcriptPath` (`contexte/antigravity-agent.md`).
- Codex: hook payload or `~/.codex/sessions/**/rollout-*.jsonl` matched by the worktree cwd.
- OpenCode: session id from its hook/plugin or `opencode.db` (`session.directory` = worktree path).
- Claude / Cline: whatever the existing adapter exposes; if nothing reliable, no button.
If an id cannot be found reliably for an agent, record nothing for it and hide the button; do not guess. **[assistant's call]**

"View agent session" opens a read-only transcript panel in the detail view. **[user: option A]** Rules:
- The runtime reads the agent's saved transcript and returns a normalized list of turns: `{ role: "user" | "assistant" | "tool", text: string, at?: number }` (tool calls shown as one line: tool name + short argument summary; tool output collapsed). **[assistant's call]**
- Sources per agent (**[builder]** confirms formats against real files and records them in `contexte/`): Codex `~/.codex/sessions/**/rollout-*.jsonl`; Antigravity `~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl`; OpenCode `~/.local/share/opencode/opencode.db` (read-only; tables `session`, `message`, `part`) or `opencode export <sessionId>` if the installed CLI has it; Claude `~/.claude/projects/**/<sessionId>.jsonl`. No new dependency unless a format cannot be read without one; say so in the task report if that happens.
- Security: the runtime only reads paths it recorded itself in `agentSession` and only under those agent home directories; never a path sent by the browser.
- Never starts, resumes, or writes to any agent process or file. Missing or unreadable transcript → "Transcript not available (<reason>)."
- Large transcripts: render the newest 500 turns with "Load earlier". **[assistant's call]**
- The button is hidden for a run without a recorded `agentSession`.

## 6. Changed files and diff (G3)

Read with git from the workspace repo: `git show --stat --format= <commit>` and the per-file diff for the commit recorded on the pass event. Reuse the existing diff viewer used for Review cards if it can take a commit; otherwise a minimal read-only file list + unified diff. **[builder]** If the commit no longer exists (rebased away), show "Commit <hash> not found on this repository." **[assistant's call]**

## 7. UI (option C)

- Done cards become clickable; clicking opens the detail view in the same way an In Progress card opens its detail view, with ← Back. **[user]** Every Done card opens it, including discarded tasks, tasks with review off, and old tasks. Without a `pass` event with `commit`, the diff section shows "No commit recorded for this task." **[assistant's call]**
- Left: title + prompt (read-only). Right top: timeline (time, agent, event, `detail` collapsed to 3 lines with "Show all"). Right bottom: changed files/diff. "View agent session" next to each run that has an `agentSession`.
- No start, commit, move, or edit controls in this view. Dragging Done cards keeps working as today.
- Styling per `AGENTS.md` (Tailwind tokens, existing `Button`, `Tooltip`, lucide icons). Fail = `text-status-red`, pass = `text-status-green`, handoff/quota = `text-status-orange`.

## 8. Tests

- History store: events round-trip in `task-history/<taskId>.json`; `fail` duplicate with detail fills the missing detail; `detail` truncation; `loadTaskHistory` order; missing/corrupt file → `[]`; `task delete --task-id` and `--column` remove the file; moving to Done keeps it; `agent-scores.json` unchanged by deletion.
- Transcript readers: one fixture per agent format (codex rollout, agy transcript_full, opencode db rows or export, claude jsonl) → expected normalized turns; a path outside the agent home is refused.
- Runtime/CLI: `task send` on a review-round card stores `detail`; `task review-failed --message`; `task done --review-passed --commit`; public handoff stores `handoff` with reason and `toAgentId`; quota branch and retry store their events; none of the new events change scores.
- Prompt: step 2 uses `--commit`, step 4 uses `--message`.
- Web UI: Done card click opens the detail view; timeline renders fail/pass/handoff; "No history recorded" for a card without events; no action buttons besides Back and "View agent session"; the transcript panel renders normalized turns and the not-available message; diff section renders for a commit and shows the not-found message otherwise.
- Integration: extend `test/integration/quota-agent-scores.integration.test.ts` or add a sibling: real CLI review-failed `--message` + done `--commit` → history API returns them in order.
- Playwright: extend the re-runnable smoke (`npm --prefix web-ui run e2e:quota-scores` pattern) with a seeded Done card that opens and shows its timeline.

Acceptance: `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast`, `npm run test:integration`, the web-ui tests touched, and the smoke command.

## 9. Left to the builder
- Exact API to fetch a task's history and a commit's diff (tRPC procedure names and shapes). **[builder]**
- How each adapter exposes session ids and how each transcript format maps to normalized turns (§5). **[builder]**
- Whether the diff view reuses the Review diff component (§6). **[builder]**
- After shipping: record the transcript formats and any adapter gotchas in `contexte/`, and note that Kanban.app needs a rebuild.
