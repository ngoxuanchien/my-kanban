# Quota detection from the OpenCode log, and immediate handoff on a clear quota message

Date: 2026-10-30
Status: approved (user, 2026-10-30)

## 1. Problem
Task 0ca38 (OpenCode) hit "Free usage limit reached", wrote no code, and fired its to_review hook with an empty worktree. The task sat in Review: no `retry` or `handoff` event was recorded, so `detectUsageLimit` (`src/server/usage-limit-detector.ts`) never found the phrase in the terminal restore snapshot. The error was only in OpenCode's own log, `~/.local/share/opencode/log/opencode.log`:

```
timestamp=2026-10-30T03:27:26.454Z level=INFO run=00a61054 message="mcp connected" ... directory=/Users/<user>/.cline/worktrees/0ca38/my-kanban ...
timestamp=2026-10-30T03:27:31.247Z level=ERROR run=00a61054 message="Failed to drain Session" cause="AI.Error: Free usage limit reached. Free models work in OpenCode ..." role=server sessionID=ses_...
```

The ERROR line has no directory; the same `run=<id>` appears on other lines that carry `directory=<task worktree>`.

Second issue: even when a quota phrase is detected, `handleUsageLimit` (`src/server/sidebar-review-service.ts`) first sends `continue` and waits `QUOTA_NUDGE_WAIT_MS` (5 min) before handing off. For an explicit quota message that wait is useless: the OpenCode free limit is per IP (`contexte/opencode-multi-account.md`).

## 2. Goals
- G1. For OpenCode tasks, the usage-limit check also reads OpenCode's log: a usage-limit phrase (`USAGE_LIMIT_PHRASES`) on a `level=ERROR` line whose `run` id also appears on a line with `directory=<this task's worktree path>`, with a timestamp at or after the session's `startedAt`, counts as detected. The screen check stays; the log is an extra source.
- G2. When a usage-limit phrase is detected (screen or log), hand off at once (or mark Out of quota when handoffs are used up), without sending `continue` first.
- G3. The silent case (no output for 5 min, no phrase) keeps today's behaviour: send `continue`, wait 5 min, then hand off.

## 3. How (decided)
- New module `src/server/opencode-log-usage-limit.ts` exporting a pure parser `findOpenCodeLogUsageLimit(logText, { worktreePath, sinceMs }): string | null` and a reader that loads the log tail. **[assistant's call]** Read at most the last 2 MiB of the file. Log path: `$XDG_DATA_HOME/opencode/log/opencode.log`, default `~/.local/share/opencode/log/opencode.log`. A missing or unreadable file returns `null` and never throws into the review flow.
- One helper in the sidebar review service combines both sources (screen first, then the log only when the task's effective agent is `opencode`). Every place that today calls `detectUsageLimit` on a task terminal snapshot uses the helper. The worktree path comes from `getTaskWorkspacePathInfo` (already used in this file).
- In `handleUsageLimit`: when `phrase` is non-null, skip the `continue` nudge and go straight to the existing handoff / quota-blocked branch. History records the `handoff` (or `quota_blocked`) event with the phrase as today.

## 4. Non-goals
- Log parsing for Codex or Antigravity.
- Changing `USAGE_LIMIT_PHRASES`, `MAX_HAND_OFFS`, the hourly quota retry, or the silent-agent nudge.

## 5. Verification
- Unit tests for the parser with synthetic log lines: phrase on an ERROR line linked by `run` to the task worktree → phrase; same phrase for another worktree's run → null; line older than `sinceMs` → null; no phrase → null.
- `sidebar-review-service.test.ts`: (1) an OpenCode task going to Review with a clean screen but a log hit hands off immediately with no `continue` sent; (2) a screen phrase hands off immediately with no `continue`; (3) the silent case still sends `continue` first.
- `npm run typecheck`, `npm run lint`, `npx @biomejs/biome check src test`, `npm run test:fast`.
