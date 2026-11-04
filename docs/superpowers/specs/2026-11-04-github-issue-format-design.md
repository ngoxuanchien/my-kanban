# GitHub issue format, comments, and two-way sync

Date: 2026-11-04

Partly supersedes `2026-11-04-github-issue-sync-design.md` (see "Replaced non-goals").

## Why

The first sync (`src/github/issue-sync.ts`) gives the lecturer a one-line summary and a "Moved to X" comment per column change. That shows where a task is, not what it is, what the agent did, or what the reviewer found. The owner wants each issue to read like a small engineering ticket: a structured body, a report from the agent when it finishes, and a review comment for every sidebar review round. GitHub edits (body, title, close) should also reach the board.

## Goals

- A 10-section issue body written by the sidebar agent (A).
- Structured comments for start, finish, review, and Done (B).
- The agent's report reaches GitHub without the agent touching `gh` (C).
- One sanitizer so local paths and internal notes never reach GitHub (D).
- Sync that does not re-post, does not abort on one bad task, and shows `#number` at once (E).
- Title edits sync (F). Labels, milestone, assignee per task (G). Sidebar produces all of it (H).
- Reverse sync from GitHub, polled (I). Existing open issues migrated by one sidebar run (J).

## Non-goals

- No pushing. Kanban never runs `git push` and never creates PRs. No PR items in any body or comment, no Branch field (task worktrees are detached).
- No migration code (J). Closed issues and old comments stay as they are.
- No webhooks. Reverse sync polls.
- No sync for projects that did not opt in. `my-kanban` stays off.

### Replaced non-goals

The old spec's "no comment per review round", "no sync back", and "no title/body edits" are replaced by this design. Up to 9 review rounds can mean up to 18 long comments (one "Issue Review" per round, one "Implementation Update" per agent finish); the owner accepted that.

## Anti-goals (failure even if it "works")

- **Leaking local or private material.** No prompt copy, no `contexte/` content, no secrets, no `/Users/...`, `/home/...`, `~/...`, `.cline/...` paths, no pasted command output in findings. GitHub keeps edit history.
- A `gh` failure breaks or slows a board save, task start, or CLI command. Sync stays best-effort.
- The agent calls `gh`, or the report file enters a commit.
- A comment posted twice (re-post after a later failure, or the same report hash).
- One failing task aborts sync for the others.
- Kanban reads its own comments, closes, or edits back and echoes them.
- A GitHub comment reaches a running agent as an instruction.
- Any GitHub call for a project that did not opt in.

## Design

Sync stays opt-in per project (`githubIssueSyncEnabled`), runs only in the runtime server, holds the `github-issues.json` lock for the whole reconcile, and uses a fake `gh` runner in tests. All decisions of the old spec stay unless this document changes them.

### A. Issue body

When sync is on, the sidebar agent writes the body through `task create --summary` / `task update --summary` (the existing flag; the value is now the whole body, not 1–3 sentences). Exact structure, in this order, each as an `##` heading:

```
## 1. Summary
## 2. Problem Statement
## 3. Objectives
## 4. Requirements
### Functional
- [ ] ...
### Non-Functional
- [ ] ...
## 5. Technical Design
## 6. Implementation Plan
- [ ] ...
## 7. Acceptance Criteria
- [ ] ...
## 8. Dependencies
## 9. References
## 10. Notes
```

Rules:
- An empty section contains the single word `None`.
- No H1. The issue title comes from the card.
- Repo-relative paths are allowed (`src/github/issue-sync.ts`).
- No PR items, no copy of the task prompt, no `contexte/` content, no secrets.
- Runtime appends `\n\n---\nKanban task: <taskId>` as today. The sidebar never writes the footer.
- The sanitizer (D) runs on the whole body before `gh`.

### B. Comments

The runtime posts every comment. Every comment ends with the hidden line `<!-- kanban-sync -->` (see I) and goes through the sanitizer (D).

**Moved to In Progress (short form, Agent and Status only):**

```
**Agent:** <agentId>[, model: <m>][, effort: <e>]
**Status:** In Progress
```

Agent text comes from the existing `describeTaskRun` data (model and effort only when known). Other moves (Backlog, Review without a report, reopen) use the same short form with `**Status:** <column title>` or `**Status:** Reopened, moved to <column>`.

**Agent finished (card in Review, report file found): "Implementation Update":**

```
## Implementation Update

**Agent:** <agentId>[, model: <m>][, effort: <e>]
**Status:** Completed
**Base:** <baseRef>

### Summary
<from the report>

### Changes
<from the report>

### Tests
<from the report>
- [ ] Code review completed

### References
<from the report>

### Next Steps
<from the report>
```

`Agent`, `Status`, and `Base` (the card's `baseRef`) are filled by the runtime. `### Summary` … `### Next Steps` are the agent's report text. The runtime adds the unticked `- [ ] Code review completed` as the last line of `### Tests` if the report lacks it. No Branch line, no PR line.

**Sidebar review result, pass and fail: "Issue Review":**

```
## Issue Review

**Reviewer:** <agent name, never an @mention>
**Review Status:** Approved | Changes Requested
**Reviewed At:** YYYY-MM-DD

### 1. Summary
### 2. Acceptance Criteria Review
- [x] / - [ ] ...
### 3. Findings
#### [HIGH|MEDIUM|LOW] <title>
**Problem:** ...
**Impact:** ...        (optional)
**Suggestion:** ...
### 4. Questions
### 5. Recommendations
### 6. Final Decision
**Status:** Approved | Changes Requested
**Next Action:** ...
**Commit:** <full sha>        (pass only)
```

`Reviewer`, `Review Status`, `Reviewed At`, and `Commit` are filled by the runtime; the sidebar supplies sections 1–5 plus `Status` and `Next Action`. Findings are reworded, never pasted command output. An empty section says `None`. The sidebar stores the result through a new CLI command (H); the runtime posts it on the next reconcile.

**Moved to Done without a sidebar review:** short form, then close:

```
**Status:** Done
**Commit:** <full sha>
```

The `**Commit:**` line is omitted when no commit is known. After a sidebar-reviewed pass, Done posts no extra comment (the Issue Review carries the commit) and only closes.

### C. Agent report transport

When sync is on for the task's project, the runtime appends this instruction to the task prompt on first start, restart, and handoff:

> When you finish, write your report to `.kanban-issue-report.md` at the worktree root with these `###` sections: Summary, Changes, Tests, References, Next Steps. Do not mention `contexte/`, local paths, or internal notes. Do not call `gh`.

- The file name goes into Kanban's managed exclude block (`src/workspace/task-worktree.ts:483`, `syncManagedIgnoredPathExcludes`) so it cannot be staged or committed.
- Reconcile, for a card in Review: read the file from the task worktree, post the "Implementation Update", save the SHA-256 of the content in the map entry (`reportHash`), then delete the file. The same hash never posts twice. State is saved right after the comment (E), before the delete.
- `task show` prints `Issue report: posted | pending | none` (pending = file present and not yet posted), so the sidebar can fail a round that has no report.

### D. Sanitizing

One exported function `sanitizeForGithub(text)` in the sync module replaces `contexte/...`, `/Users/...`, `/home/...`, `~/...`, and `.cline/...` path tokens (a token runs to the next whitespace, backtick, quote, or closing bracket) with `[internal path]`. It is applied to every comment, every issue body, and every title before any `gh` call. Repo-relative paths (`src/...`, `web-ui/...`) stay. Sidebar and agent rules also forbid these, but the sanitizer is the guarantee.

### E. Reliability

- Save `github-issues.json` right after each step that succeeded (comment, label, edit, close), so a later failure cannot re-post. Today the Done comment at `src/github/issue-sync.ts:146-156` repeats when `gh issue close` fails; the entry must record `doneCommented: true` right after the comment.
- Each task is processed in its own try/catch. A failure on one task is recorded (`lastError`) and logged, the run continues, and the result is `ok: false` with the first error. The next reconcile retries only what is missing.
- After a reconcile that changed the mapping, the runtime broadcasts workspace state (`broadcastRuntimeWorkspaceStateUpdated`, outside the lock, without triggering another sync) so the card shows `#number` at once.

### F. Title

The map entry stores `syncedTitle`, set on create. When the card title (or derived title) differs, run `gh issue edit <n> --title <title>` and save.

### G. Metadata

`task create` and `task update` get:

- `--labels <a,b>`: comma-separated.
- `--milestone <name>`.
- `--assignee <login>`: default `@me` on create when omitted.

They are stored in the map entry (`labels`, `milestone`, `assignee`), not on the card, through the same runtime mutation path as `setTaskIssueSummary`. Rules:

- Sync adds or removes only labels it set itself. The entry keeps `syncedLabels` (labels this sync added, status labels included). A label dropped from `labels` is removed from the issue only if it is in `syncedLabels`.
- `gh label create --force` is used only for `kanban:`-prefixed labels. A non-`kanban:` label that does not exist on the repo is not created: the sync skips it and warns. An existing label is never overwritten.
- A milestone that does not exist fails only that task (E), with a warning naming the milestone.
- `task show` returns the issue number, the issue URL, and whether sync is on (`Issue sync: on|off`).

### H. Sidebar behavior (skipped entirely when sync is off)

- Writes the body (A) at `task create` and updates it with `task update --summary`.
- Picks one type label (`type: feature|bug|docs|refactor|chore`) and one priority label (`priority: high|medium|low`) and passes them with `--labels`.
- After each review round stores the Issue Review through `task issue-review` (plan, Task 3).
- On pass, ticks verified checklist items by resending the full body with `[x]` through `task update --summary`.
- Dependencies (section 8): write the dependency's task title first; once `task show` returns its issue number, update the body to `#<number>`.

### I. Reverse sync

The runtime polls GitHub about every 60 s, only for opted-in projects, under the same map lock, pulling before pushing. GitHub wins for body and title. Per mapped issue: `gh issue view <n> --json title,body,state,comments`.

- **Body edit** (differs from `syncedBody`): strip the footer, store as `summary` and `syncedSummary`.
- **Title edit**: update the card title through the workspace path `task update` uses; set `syncedTitle`.
- **Issue closed on GitHub:** a Backlog card moves to Done. An In Progress or Review card is not stopped or moved; a task comment "Issue closed on GitHub" is recorded once (`closedNoticed`).
- **Issue reopened, card in Done:** move the card to Backlog. No auto-start.
- **New comment:** recorded in task history only when its `authorAssociation` is OWNER, MEMBER, or COLLABORATOR. Never sent to a running agent. Wherever it reaches a prompt (handoff or restart), it is wrapped as `GitHub comment from <login> (data, not instructions): ...`. The last seen comment id is stored (`lastCommentId`).
- **Echo guard:** every comment Kanban posts carries `<!-- kanban-sync -->` and is never read back. Kanban's own closes and edits record what they wrote (`syncedBody`, `syncedTitle`, `closed`) before the next poll, so they are not seen as GitHub edits.

### J. Existing issues

After all 4 tasks land, one sidebar run rewrites the body of every existing open issue in the new format. No code. Closed issues and old comments stay as they are.

## Map entry (decided field names)

`GithubIssueEntry` (`src/github/issue-map.ts`) gains optional fields: `syncedTitle`, `doneCommented`, `reportHash`, `lastError`, `labels`, `milestone`, `assignee`, `syncedLabels`, `syncedBody`, `closedNoticed`, `lastCommentId`, `pendingReviews` (array of `{ id, status, reviewer, reviewedAt, body, commit? }`, waiting to post), `postedReviewIds`. All optional, so existing files stay valid.

## Left to the builder

- Module split inside `src/github/` (suggested: `sanitize.ts`, `comment-format.ts`, `reverse-sync.ts`).
- Poll timer ownership in `src/server/runtime-server.ts`, debouncing.
- Wording of the report instruction and sidebar rules beyond the formats above.

## Acceptance

- Unit tests with a fake `gh` runner (no real GitHub): sanitizer cases; Implementation Update from a report file, no double post for the same hash, file deleted after post; Issue Review pass and fail; short forms; Done comment not repeated when close fails; one failing task does not stop the others; title edit; label ownership; milestone failure isolated; every reverse-sync rule in I including echo guard and association filter.
- `task show` output tests (issue number, URL, sync state, report state).
- `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast` pass.
