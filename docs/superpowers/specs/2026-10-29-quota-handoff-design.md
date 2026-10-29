# Quota handoff — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-agent-handoff-design.md`, `2026-10-29-empty-task-nudge-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Problem

The agent handoff assumed that an agent out of quota exits, so the crash trigger catches it. It does not. On 2026-10-29, task `1933a` (OpenCode) hit `AI.Error.QuotaExceeded: Free usage limit reached` (`~/.local/share/opencode/log/opencode.log`). The OpenCode TUI stayed alive and ended its turn through the hook (`state: awaiting_review`, `reviewReason: "hook"`, `exitCode: null`) with an empty worktree. Result: one empty-task nudge, then review rounds that could never pass. Each round costs a Claude turn, and the handoff only comes after round 3.

The user wants this case handed off right away. **[user]**

## 2. Goals, non-goals

### Goals
- G1. When a review-enabled codex/opencode task ends its turn and its terminal shows a usage-limit message, hand it off at once with `handOffTask` (same rules as the crash trigger: not already handed off, review on, not in trash). No nudge, no review round.
- G2. Reason text (exact): `The previous agent hit its usage limit ("<matched phrase>").`
- G3. If the task was already handed off (both agents out of quota), do not wake the sidebar for a review that cannot pass. Leave the task in Review and `deps.warn` once. **[assistant's call]**

### Non-goals
- Reading OpenCode's own log file. Its lines carry an OpenCode session id but no worktree path, so mapping a line to a task is fragile. **[assistant's call]**
- Waiting for the quota to reset, or retrying later.
- Any agent other than codex/opencode.

## 3. Detection

Source: the task's terminal screen, which the runtime already keeps: `terminalManager.getRestoreSnapshot(taskId)` (`src/terminal/session-manager.ts:289`), backed by `TerminalStateMirror.getSnapshot()` (`src/terminal/terminal-state-mirror.ts:77`). Strip ANSI escape codes from `snapshot`, then check only the **last 40 lines** of text, so a phrase quoted in the task prompt scrolled far above does not match. **[assistant's call]**

Phrases (case-insensitive, matched as plain substrings):
- `Free usage limit reached` (OpenCode; seen in the real log on 2026-10-29).
- `hit your usage limit` (Codex). **[builder]** to confirm against the installed Codex CLI if possible (for example `strings` on the binary or its source). If the real text differs, use the real text and note it in `contexte/memory-orchestrator.md`.

Keep the phrase list in one exported constant, `USAGE_LIMIT_PHRASES`, in a new file `src/server/usage-limit-detector.ts`, with `detectUsageLimit(screenText: string): string | null` (returns the matched phrase as written in the list, or `null`).

## 4. Where it runs

`src/server/sidebar-review-service.ts` `handleSummary`, on a reviewable turn end (the `reviewable` branch, after the card checks and **before** the empty-task check):
1. Get the snapshot (`null` → skip detection). Errors → `deps.warn` and continue as today.
2. If a phrase matches and the card's `agentId` is codex/opencode:
   - not handed off → `deps.handOffTask(taskId, reason)`; on `ok` stop here; on failure `deps.warn` and continue as today.
   - handed off → `deps.warn("[sidebar-review] Task <id>: both agents hit their usage limit; leaving it in Review")` and stop (no nudge, no round, no wake-up).
3. No match → today's path (empty-task nudge, then review).

Only terminal-backed sessions have a snapshot; Cline sessions skip detection. **[assistant's call]**

## 5. Tests

- `test/runtime/server/usage-limit-detector.test.ts`: each phrase matches inside ANSI-coloured text; case-insensitive; a phrase only above the last 40 lines does not match; plain text → `null`.
- `test/runtime/server/sidebar-review-service.test.ts`:
  1. turn end, snapshot with the OpenCode phrase, card not handed off → `handOffTask` called with the exact reason; no nudge, sidebar not woken, `reviewRound` unchanged;
  2. same on a handed-off card → no `handOffTask`, no nudge, no wake-up, one `warn`;
  3. `handOffTask` returns `{ ok: false }` → warn, then the normal path (nudge or review);
  4. snapshot `null` or without a phrase → normal path unchanged;
  5. `getRestoreSnapshot` throws → warn, normal path.

## 6. Left to the builder
- ANSI stripping: a small regex or an already-installed package; no new dependency just for this. **[builder]**
