# Empty task nudge — design

Date: 2026-10-29
Status: approved by the user in chat ("làm 1, 2, 3, 4 luôn")
Builds on: `2026-10-29-sidebar-agent-review-design.md`

## Problem

In the first sidebar review smoke test (task `24cba`, OpenCode), the agent ended its turn without changing any file. The runtime still woke the Claude sidebar, which spent a review round (Claude Pro tokens) only to find an empty diff. This is the known OpenCode habit of reporting "done" without checking (`contexte/memory-orchestrator.md`, Findings).

## Design

In `src/server/sidebar-review-service.ts`, when a review-enabled task ends its turn (the point where `queue.onTaskTurnEnd` is called today), check the task worktree first:

- Worktree path: `getTaskWorktreePath(workspacePath, taskId)` (`src/workspace/task-worktree.ts`).
- Empty means both: `git status --porcelain` prints nothing (includes untracked files), and `git rev-list --count <card.baseRef>..HEAD` is `0` (the agent did not commit by itself). Use `runGit` (`src/workspace/git-utils.ts`).

If the worktree is empty and the task has not been nudged since its last review round:

- Do not wake the sidebar and do not increase `reviewRound`.
- Send this message to the task session with `sendPromptToSession` (`sessionId` = task id, `agentId` = `summary.agentId`):
  `[Kanban] No changes found in your worktree (git status is clean and there are no commits since <baseRef>). The task is not done. Make the changes the task asks for, run every acceptance command, and paste the output.`
- Remember the task id as nudged (in memory).

If the task was already nudged, or the worktree has changes, continue as today (round + wake the sidebar) and clear the nudged mark. This caps it at one nudge per round, so an agent that keeps doing nothing cannot loop forever; the sidebar review then fails it normally.

If the git check throws (for example the worktree is missing), log with `deps.warn` and continue as today.

## Non-goals

- Detecting edits to git-ignored files (such as `contexte/` symlinks). A task that only edits those gets one nudge, then is reviewed normally.
- Persisting the nudged mark across runtime restarts.

## Tests

In `test/runtime/server/sidebar-review-service.test.ts`:
1. Empty worktree, first turn end → task gets the nudge message, sidebar is not woken, `reviewRound` stays 0.
2. Empty worktree, second turn end after a nudge → sidebar is woken with round 1.
3. Worktree with changes → sidebar woken with round 1, no nudge (existing behaviour).
4. Git check throws → sidebar woken with round 1.
