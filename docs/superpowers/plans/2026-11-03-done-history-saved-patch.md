# Plan: Done history shows the saved patch

Spec: `docs/superpowers/specs/2026-11-03-done-history-saved-patch-design.md`

One Kanban task (runtime and UI are small and tightly coupled).

## Task 1: Show saved task patch in Done history
1. `src/workspace/task-worktree.ts`: export a function that finds the task's saved patch via `findTaskPatch()` and returns its file changes (or null), using a temporary index as described in the spec. Never modify the real index or working tree.
2. Extract the per-file old/new text building from `getCommitChanges` (`src/trpc/runtime-api.ts:960`) into a shared helper that diffs two tree-ish refs. Use it for both commits and the patch tree.
3. `src/core/api-contract.ts`: add `runtimeTaskPatchChangesRequestSchema` (`{ taskId }`) and a response schema (workspace changes, or `{ notFound: true }`). Wire `getTaskPatchChanges` in `runtime-api.ts` and `app-router.ts` next to `getCommitChanges`.
4. `web-ui/src/components/done-task-detail-view.tsx`: when there is no commit or the commit is not found, query the patch. When it has files, render `DiffViewerPanel` with them and the label "Uncommitted changes saved when the task was moved to Done". Otherwise keep the current messages.
5. Tests as listed in the spec.

Acceptance: `npm run typecheck && npm run lint && npm run test:fast`, and `cd web-ui && npm run typecheck && npm run test`. Manual: open Done task 2978e and see `contexte/kanban-cli-oom.md` in the diff area.
