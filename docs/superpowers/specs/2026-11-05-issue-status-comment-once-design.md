# Status comment once per column

Date: 2026-11-05

> Follow-up to `2026-11-04-github-issue-format-design.md`.

## Problem

GitHub issue sync posts a `**Agent:** … **Status:** <column>` comment on every column change. The runtime moves cards In Progress ↔ Review each time an agent turn ends, so a nudge or a new review round can post several status comments within minutes (issue `ngoxuanchien/mapf-cbs-ecbs-project#26`: five in six minutes). The comments are noise: the status label already shows the current column, and each review round has its own Issue Review comment.

## Design

- New optional field `commentedColumns?: RuntimeBoardColumnId[]` on `GithubIssueEntry` and the zod `issueMapSchema` (unknown keys are stripped otherwise).
- In the column-change branch of `reconcileGithubIssues` (`src/github/issue-sync.ts`):
  - Always update the status label as today.
  - Post the status comment only when `entry.closed` (reopen) or `column.id` is not in `commentedColumns`.
  - After a reopen comment, set `commentedColumns` to `[column.id]`.
  - After a first-time comment, append `column.id`.
  - A skipped comment leaves `commentedColumns` as is.
- Done/trash comments, Implementation Update and Issue Review comments are unchanged.

## Non-goals

- Debounce/timers, UI changes, changing when the runtime moves cards between columns, the empty-worktree nudge.

## Acceptance

- In Progress → Review → In Progress → Review posts exactly two status comments (In progress, Review) and edits the label on every move.
- A closed issue moving back to a column already commented still posts "Reopened, moved to …".
- `commentedColumns` survives a save/load of the issue map.
