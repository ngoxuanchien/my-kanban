# Quota detection: stop false positives from screen text

Builds on: `2026-10-29-quota-handoff-design.md`, `2026-10-30-opencode-log-quota-design.md`, `2026-10-30-handoff-reason-self-trigger-design.md`.

## Problem
`detectUsageLimit` (`src/server/usage-limit-detector.ts`) matches a usage-limit phrase anywhere in the last 40 screen lines. `checkStuckTasks` (`src/server/sidebar-review-service.ts:317-334`) runs it on every tick while a task is **running**, so any text the agent prints counts as a quota hit.

Seen on 2026-10-30, task 7a7fb: Codex had used 31% of its quota (`"used_percent":31.0` in its transcript), printed a `git diff` of `test/runtime/server/sidebar-review-service.test.ts` that contained `hit your usage limit`, and was handed off within seconds. Any task that touches quota code, tests, or docs can trip this.

## Real quota signals (checked on this Mac)
- OpenCode: `~/.local/share/opencode/log/opencode.log`, an `level=ERROR` line with `Free usage limit reached`, linked to the worktree by run id. Already read by `findOpenCodeLogUsageLimit`.
- Antigravity: one log file per session, `~/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log`. The line `Creating CLI server backend: ... workspaceDirs=[<worktree> ...]` names the worktree. Quota error lines start with `E` and contain `RESOURCE_EXHAUSTED (code 429): Individual quota reached`. Timestamps in the file name and lines are local time.
- Codex: no real quota event has ever been recorded in `~/.codex/sessions`. The screen is the only source.

## Design
1. **Quiet screen rule.** While the task is `running`, a screen phrase counts only when the agent has produced no output for at least 30 s (`QUOTA_SCREEN_QUIET_MS = 30_000`, measured from `summary.lastOutputAt ?? summary.startedAt`) and the phrase is in the last **10** lines (was 40). An agent that hit its quota stops printing. An agent printing a diff or a file does not. In `awaiting_review` (turn ended), only the 10-line rule applies.
2. **Antigravity log source.** New `src/server/antigravity-log-usage-limit.ts`, mirroring `opencode-log-usage-limit.ts`:
   - `findAntigravityLogUsageLimit(files: { name: string; text: string }[], { worktreePath, sinceMs })`: among files whose `workspaceDirs=[...]` contains `worktreePath` and whose name time is ≥ `sinceMs` minus 60 s, return `"Individual quota reached"` if any `E` line contains `RESOURCE_EXHAUSTED` and `Individual quota reached`; else `null`.
   - `readAntigravityLogs()`: read the 5 newest `cli-*.log` files in `~/.gemini/antigravity-cli/log/` (last 512 KiB of each); return `[]` on any error.
   - Injected into the service as `deps.readAntigravityLogs` with that real default; the test helper defaults it to `async () => []`.
3. In `findUsageLimit` (`sidebar-review-service.ts:78`): screen first (with the new rules), then the log for the effective agent: opencode → OpenCode log, antigravity → Antigravity log, codex → none.
4. Add `Individual quota reached` to `USAGE_LIMIT_PHRASES`.

## Not changed
Nudge, handoff, quota-blocked and retry flows; Codex detection beyond the quiet rule.

## Known limit
A Codex quota message is still recognised only on screen; if Codex keeps repainting while blocked, the quiet rule delays detection until the 5-minute silent nudge path. Revisit once a real Codex quota event is captured.
