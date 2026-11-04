# GitHub issue sync for Kanban tasks

Date: 2026-11-04

> Partly superseded by `2026-11-04-github-issue-format-design.md` (issue body, comments, sync back, title edits).

## Why

The owner uses Kanban on a course project (`mapf-cbs-ecbs-project`). The lecturer follows progress on GitHub and never opens Kanban. Kanban tasks are local only, so the lecturer currently sees nothing. Each task should have a GitHub issue that shows where the task is (backlog, in progress, review) and, when it is done, which commit finished it.

## Goals

- Opt-in per project. Off by default. The `my-kanban` repo itself stays off.
- Creating a task creates an issue on the project's GitHub repo.
- Moving a task between columns updates the issue: one status label for the current column, plus a short comment.
- Moving a task to Done adds a comment with the commit hash (when known) and closes the issue.
- Deleting a task closes its issue as "not planned".
- Turning sync on for a project that already has tasks creates issues for its open tasks (backlog, in progress, review) only. Done tasks get no issue.
- Works the same whether the board changes from the web UI or from the Kanban CLI (the sidebar agent uses the CLI).

## Non-goals

- No sync from GitHub back to Kanban. Editing or closing an issue on GitHub does not change the board.
- No comment per review round (pass/fail/handoff). Only column changes and the final commit.
- No pushing. Kanban never runs `git push`. A commit hash in a comment becomes a link on GitHub only after the owner pushes.
- No editing the issue title/body when the task title changes later.

## Anti-goals (failure even if it "works")

- **The task prompt reaches GitHub.** Prompts carry private notes copied from the local-only `contexte/` memory, local file paths, and review failure output. GitHub keeps issue edit history, so a leak cannot be fully undone. Never put the prompt, review messages, or task comments in an issue or issue comment.
- A `gh` failure (not installed, not logged in, offline, no GitHub remote) breaks or slows a board save, a task start, or a CLI command. Sync is best-effort and must never block or fail board writes.
- Duplicate issues for one task (e.g. the CLI process and the runtime server both syncing the same change).
- Any GitHub call for a project that did not opt in.

## Decided

- **Transport:** the `gh` CLI already on the machine, run with `cwd` = the project repo path so `gh` picks the repo from the git remote. No token handling in Kanban. Launch `gh` directly (no interactive shell; see AGENTS.md).
- **Setting:** a boolean `githubIssueSyncEnabled` in the project config file `.cline/kanban/config.json` (`RuntimeProjectConfigFileShape` in `src/config/runtime-config.ts:24`, next to `shortcuts`), with a toggle in the project section of `web-ui/src/components/runtime-settings-dialog.tsx`.
- **Where sync runs (planner's call):** only in the runtime server process, never in the short-lived CLI process (`src/cli.ts` calls `process.exit` right after the command, which would drop an un-awaited sync). The runtime triggers a sync from `broadcastRuntimeWorkspaceStateUpdated` in `src/server/runtime-state-hub.ts` (reached by UI saves, the CLI's `workspace.notifyStateUpdated`, and runtime writes; outside the workspace lock), and on startup for each opted-in workspace. CLI commands that write the board send a fire-and-forget "sync requested" call to the runtime over the tRPC client they already create (`createRuntimeTrpcClient`); the CLI does not wait for GitHub. `gh` therefore runs on the machine that hosts the runtime.
- **Sync is reconciliation, not event replay:** the sync compares the current board against a stored record of what was last pushed to GitHub, and pushes the difference. A failed `gh` call is retried naturally on the next board write.
- **Mapping storage:** a separate file in the workspace data directory (next to `task-history/`, via `getWorkspaceDirectoryPath`), e.g. `github-issues.json`: `{ [taskId]: { issueNumber?, syncedColumn?, summary?, skipped? } }`. Do **not** add a field to the board card (AGENTS.md: a new card field must be threaded through seven rebuild sites in `web-ui/src/state/board-state.ts`).
- **Sync must hold a lock** on the mapping file (use `lockedFileSystem`) for the whole reconcile, so two processes cannot create two issues for one task.
- **Issue content:** title = task title (or the derived title). Body = the summary, if any, then a footer line `Kanban task: <taskId>`. Nothing else.
- **Summary:** new optional flag `task create --summary "<1–3 sentences>"` on the Kanban CLI. It is written to the mapping file entry for the new task (not to the card) and used only when the issue is created. The sidebar agent instructions (the `task create` CLI reference in the sidebar system prompt) document the flag and say: when sync is on, write a short, lecturer-facing summary with no file paths, no `contexte/` content, and no secrets. Without `--summary`, the body is the footer only.
- **Labels:** `kanban: backlog`, `kanban: in progress`, `kanban: review`. Exactly one is on an open issue. Create labels on first use if missing (`gh label create --force`). Closed issues drop the status label.
- **Comments:** fixed templates only, one per column change, e.g. "Moved to In progress (agent: codex)" or "Moved to In progress (agent: claude, model: opus)". Agent = the card's `agentId`. Model only when Kanban knows it: for `claude`, the card's `claudeModel`, else the runtime config `claudeDefaultModel`; for `cline`, `clineSettings.modelId`; for codex, opencode, antigravity Kanban does not know the model, so only the agent is shown. Omit the whole " (…)" suffix when the card has no `agentId`. On Done: "Done in commit `<full sha>`" using the `commit` of the latest `pass` event in task history (`src/state/task-history.ts`; `task done --review-passed --commit` records it before the task moves), or "Moved to Done" when there is none. Then close the issue.
- **Close reason (planner's call):** Done and trash are the same column (`done` maps to `trash` in `src/core/api-contract.ts:142`), so any move to Done closes the issue as completed, with the commit comment when a `pass` event has one.
- **Task leaves Done (planner's call):** if a task with a closed issue moves back to an open column, reopen the issue, put the matching status label back, and comment "Reopened, moved to <column>".
- **Deleted task:** a mapped task no longer on the board whose issue is still open → close as not planned. If the issue is already closed (the usual `task delete --column done` cleanup), do nothing (planner's call).
- **Backfill:** happens automatically through reconciliation: when sync is on, an open task with no issue gets one. The mapping entry is written the first time a task is seen in an open column (at create time, or at the first sync), even when the `gh` call fails, so a task created offline still gets an issue later even if it reaches Done first (then the issue is created and closed). Only a task first seen already in Done with no entry is recorded as `skipped` and never gets an issue.
- **Web UI (the owner must be able to run this without the sidebar agent):**
  - Settings: the per-project toggle, plus a **Sync now** button that runs one reconcile for the current project and shows a toast with the result (done / the `gh` error message).
  - Create task dialog: an optional **Issue summary** field, shown only when sync is on for the project. It is stored the same way as `--summary` (mapping file, not the card). The summary must be in the mapping file before the sync creates that task's issue; how to order this (e.g. write the summary before the board save, or have the runtime write both in one call) is the builder's choice, but an issue must never be created without a summary that the user entered.
  - Card: when the task has an issue, show `#<number>` on the card; clicking it opens the issue URL in the system browser (the desktop app already routes external links there). The issue number/URL reaches the UI through runtime state or a query, not a card field. Store the issue URL in the mapping entry.
- **Errors:** log a warning through the existing runtime logging; no toast/UI error is required.

## Left to the builder

- Exact module layout (e.g. `src/github/issue-sync.ts`) and how the sync reads the project path and setting from a workspace id.
- Debouncing/coalescing several rapid writes into one reconcile.
- Wording of comments and the settings toggle label.
- Test approach: inject a fake `gh` runner; no test may call the real `gh` or GitHub.

## Acceptance

- Unit tests cover: off → no `gh` calls; create → issue + label, body contains summary and task id but never the prompt; column move → label swap + comment; Done with and without commit → comment + close; deleted open task → close not planned, deleted closed task → no call; task back from Done → reopen + label; backfill skips Done tasks; task created offline then Done still gets an issue (created and closed); CLI write → sync requested from the runtime, CLI never calls `gh`; UI summary ends up in the issue body; Sync now runs one reconcile; web-ui tests for the summary field (hidden when sync is off) and the card `#<number>` link; a failing `gh` runner leaves the board write successful and the mapping unchanged so the next sync retries; concurrent syncs create one issue.
- `npm run typecheck`, `npm run lint`, `npm run test:fast` pass.
