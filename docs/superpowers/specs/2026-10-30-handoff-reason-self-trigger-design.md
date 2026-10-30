# Handoff reason must not re-trigger quota detection

## Problem
On 2026-10-30, task 8454f (InstallApp board) went opencode → codex → antigravity within seconds and used up both handoffs with an empty worktree.

- OpenCode really hit its quota: `opencode.log` has `level=ERROR run=0d4c652d ... Free usage limit reached` at 08:29:16Z, and run `0d4c652d` ran in `~/.cline/worktrees/8454f/InstallApp`. That first handoff was correct.
- The handoff reason was `The previous agent hit its usage limit ("Free usage limit reached").` (`src/server/sidebar-review-service.ts:287`).
- `buildHandoffPrompt` appends that reason to the next agent's prompt (`src/server/hand-off-task.ts:39`). Codex shows its prompt in the terminal, so the last 40 screen lines contained `Free usage limit reached`. `detectUsageLimit` matched it, and codex was handed off to antigravity right away, although codex had no quota problem.

## Design
- The reason passed to `handOffTask` for a usage-limit handoff becomes exactly: `The previous agent hit its usage limit.` It contains no phrase from `USAGE_LIMIT_PHRASES`.
- The history event `detail` keeps the matched phrase for diagnosis: `The previous agent hit its usage limit ("<phrase>").` History is only shown in the Done view, never on a task terminal.
- No other behavior changes.

## Known limit
A task whose own prompt quotes a usage-limit phrase can still trip screen detection. Not fixed here; fix if it happens.
