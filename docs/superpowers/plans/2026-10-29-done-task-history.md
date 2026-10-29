# Done Task History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Done cards open a read-only detail view with a history timeline (agents, failed rounds with full reasons, handoffs, quota events, pass commit), the commit diff, and a read-only transcript of each agent run.

**Architecture:** A new per-task history file `task-history/<taskId>.json` (separate from `agent-scores.json`) holds history events with `detail`/`commit`/`agentSession`, recorded where reviews, handoffs and quota events already happen, and deleted when the task is permanently deleted. The runtime exposes three read-only queries (task history, commit changes, agent transcript). The web UI opens Done cards in a read-only detail view.

**Tech Stack:** TypeScript, Node runtime (`src/`), React web UI (`web-ui/`), Vitest, Playwright, Biome.

**Spec:** `docs/superpowers/specs/2026-10-29-done-task-history-design.md`

## Global Constraints

- Read-only: nothing in this feature starts, resumes, or writes to an agent process, moves a task, or commits.
- History lives in `<workspaceDir>/task-history/<taskId>.json` (`{ version: 1, events }`), never in `agent-scores.json`; scoring code and `agent-scores.json` are unchanged.
- Permanently deleting a task (CLI `task delete --task-id`/`--column` and the UI delete path) removes its history file; moving to Done keeps it; deletion never touches `agent-scores.json`.
- `detail` capped at 20,000 characters, truncated with `… (truncated)`.
- Commit recorded is the base-branch (cherry-picked) hash passed via `--commit`.
- Transcript reads: only paths the runtime itself recorded in `agentSession`, only under `~/.codex`, `~/.gemini/antigravity-cli`, `~/.local/share/opencode`, `~/.claude`. Never a path from the browser.
- Empty states (exact): `No history recorded for this task.`, `No commit recorded for this task.`, `Commit <hash> not found on this repository.`, `Transcript not available (<reason>).`
- No new dependencies unless a transcript format cannot be read otherwise (report it). No `any`. No inline imports.
- Acceptance for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast`; Task 2 also `npm run test:integration`; Task 3 also `npm run web:typecheck`, the touched web-ui tests, and the Playwright smoke command.

## Review Focus

1. A history event written while the UI saves the board must not be lost → history files are separate from `board.json`; Task 1 store test with concurrent writes to one task file.
2. `task handoff` right after `task review-failed` in the same round keeps one `fail` with the reason → Task 1 test.
3. A transcript path outside the allowed homes (e.g. a tampered history file) is refused → Task 2 test.
4. A Done card without events, and one whose commit was rebased away, render their empty states instead of erroring → Task 3 tests.
5. Opening a Done card must not start a session or move the card (no `startTaskSession` call) → Task 3 test.

## Kanban tasks and order

| Task | Agent | Depends on |
|---|---|---|
| 1. Event log extension + recording + CLI flags + sidebar prompt | antigravity | — |
| 2. Session capture, transcript readers, read-only queries | codex | 1 |
| 3. Done card detail view (timeline, diff, transcript) + smoke | antigravity | 2 |

---

### Task 1: History store, recording, deletion, CLI flags, sidebar prompt

**Files:**
- Create: `src/state/task-history.ts`
- Modify: `src/trpc/runtime-api.ts` (`startTaskSession`, `sendTaskMessage`), `src/trpc/app-router.ts` (public `handOffTask` procedure)
- Modify: `src/server/sidebar-review-service.ts` (quota/crash handoff, quota branch, retry path)
- Modify: `src/commands/task.ts` (`task done --commit`, `task review-failed --message`, `task delete` history removal) and the shared runtime delete path the UI uses (find it; delete history there so both paths are covered once)
- Modify: `src/prompts/append-system-prompt.ts` ("Reviewing tasks" steps 2 and 4, CLI reference)
- Test: `test/runtime/state/task-history.test.ts`, `test/runtime/agent-score-recording.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, `test/runtime/task-command-agent-id.test.ts`, `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Produces in `src/state/task-history.ts`:
  - `TaskHistoryEventType = "started" | "fail" | "handoff" | "quota_blocked" | "retry" | "pass" | "session"`
  - `AgentSessionRef = { agentId: string; id?: string; transcriptPath?: string }`
  - `TaskHistoryEvent = { type; agentId: string; at: number; round?: number; detail?: string; commit?: string; toAgentId?: string; agentSession?: AgentSessionRef }`
  - `recordTaskHistoryEvent(workspaceId: string, taskId: string, event: Omit<TaskHistoryEvent, "at">, now?: () => number): Promise<boolean>`
  - `loadTaskHistory(workspaceId: string, taskId: string): Promise<TaskHistoryEvent[]>` — sorted by `at`; missing/corrupt → `[]`.
  - `deleteTaskHistory(workspaceId: string, taskId: string): Promise<void>` — missing file is fine.
- Produces CLI: `task done --task-id <id> --review-passed [--commit <hash>]`; `task review-failed --task-id <id> [--message <text>]`.

Rules:
- File `<getWorkspaceDirectoryPath(workspaceId)>/task-history/<taskId>.json`, `{ version: 1, events }`, read-modify-write inside `lockedFileSystem.withLock` (file lock), `writeJsonFileAtomic`.
- De-dup: `fail` once per round (later `fail` same round with `detail` fills a missing one); `pass` once; `session` once per `agentSession.id`; others drop only an identical event within 5,000 ms. `detail` truncated to 20,000 chars + `… (truncated)`.
- Record (next to the existing score events, which stay unchanged): start → `started`; `task send` to a review-round card → `fail` with `detail`; public `handOffTask` ok → `fail` with `detail` = request reason + `handoff` with `toAgentId`; runtime quota/crash handoff → `handoff` with the runtime reason; quota branch → `quota_blocked`; retry → `retry` with the new agent; `task review-failed --message` → `fail` with `detail`; `task done --review-passed --commit` → `pass` with `commit`. History errors are warned, never fail the command.
- Delete: permanent delete of a task (CLI single and `--column`, and the UI delete path) calls `deleteTaskHistory`; moving to Done does not.
- Prompt: step 2 `task done --task-id <task_id> --review-passed --commit <hash of the cherry-picked commit on the base branch>`; step 4 `task review-failed --task-id <task_id> --message "<the same fix list>"` in both cases.

- [ ] **Step 1: Failing tests** — store: round-trip; `fail` duplicate with detail fills it; 25,000-char detail stored as 20,000 + suffix; `loadTaskHistory` sorts by `at`; missing/corrupt → `[]`; two concurrent writes to one task file both persist; delete removes the file and leaves `agent-scores.json` untouched; moving to Done keeps it; `task delete --column done` removes every deleted task's file. Recording: each rule above with its fields; scores unchanged by the new events. CLI: `--commit` stored on `pass`; `--message` stored on `fail`. Prompt: steps 2 and 4 contain the new flags.
- [ ] **Step 2: Run** the listed test files → FAIL.
- [ ] **Step 3: Implement** the rules.
- [ ] **Step 4: Run** → PASS; acceptance commands.
- [ ] **Step 5: Commit** `feat(runtime): record per-task history with reasons and commits`

---

### Task 2: Session capture, transcript readers, read-only queries

**Files:**
- Create: `src/state/agent-transcripts.ts` (readers per agent format → normalized turns)
- Modify: the agent session adapters / hook handling under `src/terminal/` and `src/server/` where turn ends are observed, to append `session` events
- Modify: `src/core/api-contract.ts`, `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts` (three queries)
- Test: `test/runtime/state/agent-transcripts.test.ts` (+ fixtures under `test/runtime/state/fixtures/transcripts/`), `test/runtime/task-history-api.test.ts`, extend `test/integration/quota-agent-scores.integration.test.ts`
- Record findings: `contexte/agent-transcripts.md` (new; add to `MAP.md`)

**Interfaces:**
- Consumes (Task 1): `TaskHistoryEvent`, `AgentSessionRef`, `loadTaskHistory`, `recordTaskHistoryEvent` with `type: "session"`.
- Produces (api-contract + tRPC, workspace scoped, queries only):
  - `getTaskHistory({ taskId }) → { events: RuntimeTaskHistoryEvent[] }` (zod mirror of `TaskHistoryEvent`)
  - `getCommitChanges({ commit }) → RuntimeWorkspaceChangesResponse | { notFound: true; commit: string }` — same file shape as `getWorkspaceChanges` (`src/core/api-contract.ts:15-40`) so `DiffViewerPanel` can render it.
  - `getAgentTranscript({ taskId, sessionId, before? }) → { turns: Array<{ role: "user" | "assistant" | "tool"; text: string; at?: number }>; truncated: boolean } | { unavailable: string }` — looks up the `session` event for that task/session id; reads only its recorded path; newest 500 turns.

Rules:
- Session capture: at each turn end append `session` with the agent's session id and transcript path when the adapter can find it reliably (agy Stop hook `conversationId`/`transcriptPath`; codex rollout file for the worktree cwd; opencode session whose `directory` is the worktree; claude project jsonl). If not reliable for an agent, record nothing for it.
- Path guard: resolve the real path; it must be inside one of the allowed homes; otherwise `{ unavailable: "path not allowed" }`.
- Commit changes: `git show` in the workspace repo; unknown commit → `{ notFound: true, commit }`.

- [ ] **Step 1: Failing tests** — one small real-format fixture per agent → expected turns; tool calls one line; path outside allowed homes refused; missing file → unavailable; 600-turn fixture → 500 newest + `truncated: true`; `getCommitChanges` for a real commit in a temp repo returns its files, unknown hash → notFound; `getTaskHistory` returns ordered events; integration: real CLI `review-failed --message` + `done --review-passed --commit` → `getTaskHistory` shows both with detail/commit.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; inspect real transcript files on this machine to build fixtures (strip secrets), record formats in `contexte/agent-transcripts.md`.
- [ ] **Step 4: Run** → PASS; acceptance commands incl. `npm run test:integration`.
- [ ] **Step 5: Commit** `feat(runtime): add task history, commit changes and agent transcript queries`

---

### Task 3: Done card detail view

**Files:**
- Modify: `web-ui/src/components/board-card.tsx:281-282` (Done cards clickable), the detail navigation (`useDetailTaskNavigation` used in `web-ui/src/App.tsx:229`)
- Create: `web-ui/src/components/done-task-detail-view.tsx` (+ small subcomponents for timeline and transcript panel as needed)
- Reuse: `web-ui/src/components/detail-panels/diff-viewer-panel.tsx`
- Test: `web-ui/src/components/done-task-detail-view.test.tsx`, `web-ui/src/components/board-card.test.tsx`, extend `web-ui/tests/quota-and-scores.spec.ts` + `web-ui/tests/run-quota-and-scores.mjs` (seed a Done card with history and a commit in the temp repo)

**Interfaces:**
- Consumes (Task 2): `getTaskHistory`, `getCommitChanges`, `getAgentTranscript`.

Rules:
- Clicking any Done card opens `DoneTaskDetailView` instead of `CardDetailView`; ← Back returns to the board. Dragging Done cards unchanged.
- Left: title + prompt read-only. Right top: timeline grouped by `session` runs; each event shows time, agent, label (Started / Review N failed / Handed off to X / Out of quota / Retried with X / Passed · <commit>), `detail` collapsed to 3 lines with "Show all". Colours: fail `text-status-red`, pass `text-status-green`, handoff/quota/retry `text-status-orange`.
- Right bottom: `DiffViewerPanel` for the pass commit; empty states per Global Constraints.
- "View agent session" on runs with a `session` event opens a read-only transcript panel (turn list, "Load earlier").
- No other buttons. Opening the view must not call `startTaskSession` or change the board.

- [ ] **Step 1: Failing tests** — click Done card opens the view; timeline labels and colours for a seeded history; "Show all" expands; no-history, no-commit and not-found empty states; transcript panel renders turns and the unavailable message; no `startTaskSession`/board mutation on open; Playwright: seeded Done card opens and shows "Review 1 failed" and "Passed".
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS; `npm run web:typecheck`, `npm run lint`, `npm run test:fast`, web-ui tests, `npm --prefix web-ui run e2e:quota-scores`.
- [ ] **Step 5: Commit** `feat(web-ui): open Done cards in a read-only history view`

---

## After all tasks
- Record in `contexte/memory-orchestrator.md`: history feature shipped, commit hashes, transcript formats file, and that Kanban.app needs a rebuild.
