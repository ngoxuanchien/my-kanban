# Done history: show the saved patch when no commit was recorded

## Why
Some tasks reach Done without a commit: investigation tasks that only touch local `contexte/` notes, and tasks moved to Done by hand. Their Done history view shows "No commit recorded for this task." even though the runtime already saved the task's changes. The user wants to see what such a task changed from the history view.

## What already exists
- `deleteTaskWorktree()` (`src/workspace/task-worktree.ts:565`) calls `captureTaskPatch()` (`:197`) before it removes a worktree. The patch covers tracked changes (`git diff --binary HEAD`) and untracked files (`git diff --no-index /dev/null <path>`). It is saved as `~/.cline/kanban/trashed-task-patches/<taskId>.<headCommit>.patch`. `findTaskPatch()` (`:165`) returns its path and base commit. Today it is only used to restore a task from trash.
- The Done history view (`web-ui/src/components/done-task-detail-view.tsx`, diff area ~line 515-542) loads `getCommitChanges({ commit })` (`src/trpc/runtime-api.ts:960`) for the pass event's commit and renders `DiffViewerPanel` with the returned `files`.

## Goal
When a Done task has no recorded commit, or its commit is not found, and a saved patch exists for the task, the diff area shows the patch's changes in the same `DiffViewerPanel`. A small label above the diff says: "Uncommitted changes saved when the task was moved to Done".

## Behavior
1. Pass event has a commit that exists: unchanged (commit diff).
2. No commit, or the commit is not found, and a patch exists: show the patch diff with the label.
3. Neither: unchanged ("No commit recorded for this task." / "Commit … not found").
4. It works for tasks already in Done whose patch is still on disk (for example 2978e).

## Design decisions
- New runtime query `getTaskPatchChanges({ taskId })` returning the same shape as `runtimeWorkspaceChangesResponseSchema`, or `{ notFound: true }` when there is no patch or it cannot be applied. Put it next to `getCommitChanges` in the API contract, `runtime-api.ts`, and `app-router.ts`.
- Export a helper from `task-worktree.ts` that reuses `findTaskPatch()`. Do not duplicate the patch path logic.
- Builder's call: how to turn the patch into before/after file texts. Suggested: a temporary index (`GIT_INDEX_FILE` in a temp dir), `git read-tree <baseCommit>`, `git apply --cached --binary <patch>`, `git write-tree`, then diff `<baseCommit>` against that tree the way `getCommitChanges` does. Share that file-listing code with `getCommitChanges` instead of copying it. Never touch the real index or working tree.
- The web UI fetches the patch only in case 2 above (no commit, or commit not found).

## Non-goals
- Capturing edits made through symlinked ignored paths (for example `contexte/` files that are still symlinks to the main checkout). They are not in the patch today.
- Changing when or how patches are captured or deleted.
- Showing the patch for tasks that have a commit.

## Tests
- Runtime: a test with a temp repo (`env: createGitTestEnv()`, see `AGENTS.md`) that writes a patch for a tracked edit and an untracked new file, and checks the query returns both files with the right old/new text. Also check `{ notFound: true }` when there is no patch.
- Web UI: the Done view shows the label and the diff when there is no commit and the patch query returns files, and still shows "No commit recorded for this task." when it returns `notFound`.
