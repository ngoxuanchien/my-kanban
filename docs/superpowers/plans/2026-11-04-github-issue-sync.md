# GitHub Issue Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For projects that opt in, mirror each Kanban task to a GitHub issue (status label, column comments, commit + close on Done) without ever publishing the task prompt.

**Architecture:** A runtime-only sync service reconciles the board against a per-workspace mapping file (`github-issues.json`) and calls the `gh` CLI. It is triggered from the runtime's single "workspace state changed" broadcast (which UI saves, CLI `notifyStateUpdated`, and runtime writes all reach), on startup, and by a "Sync now" tRPC call. Summaries are written to the mapping file *before* the task exists, using a pre-generated task id.

**Tech Stack:** Node/TypeScript runtime, tRPC, zod, vitest; React + Tailwind v4 web-ui.

**Spec:** `docs/superpowers/specs/2026-11-04-github-issue-sync-design.md`

## Global Constraints

- Never put the task prompt, review messages, or task comments into any issue title, body, or comment. Body = summary (optional) + `Kanban task: <taskId>`.
- No GitHub call for a project whose `githubIssueSyncEnabled` is not `true` (default `false`).
- `gh` runs only in the runtime server process, via `execFile("gh", args, { cwd: repoPath })` — no shell, no `zsh -i`.
- A `gh` failure never fails or blocks a board write, a CLI command, or a task start.
- Never add a field to the board card (`runtimeBoardCardSchema`); all issue data lives in the mapping file.
- Tests inject a fake `GhRunner`; no test calls the real `gh`. Tests that spawn `git` pass `env: createGitTestEnv()`.
- Labels, verbatim: `kanban: backlog`, `kanban: in progress`, `kanban: review`.

## Review Focus

1. `gh` not installed (`ENOENT`) or not logged in → board saves still succeed; "Sync now" toast shows the error; mapping unchanged. (Task 1: `reconcile aborts on gh error and keeps mapping`.)
2. Project has no GitHub remote → same as 1, one warning per reconcile, not one per task. (Task 1: same test, abort on first error.)
3. Title/summary containing quotes, backticks, newlines, `$(...)` → passed as one argv element, unchanged. (Task 1: `passes title and body as single argv elements`.)
4. Many rapid board writes (drag-drop bursts, backfill of 14 tasks) → one reconcile at a time per workspace, at most one queued; no duplicate issues. (Task 1: `concurrent requestSync creates one issue`.)
5. A summary set for a task id that never appears on the board → never creates an issue, never deleted-closes anything. (Task 1: `summary-only entry is ignored`.)

---

### Task 1: Runtime sync service, setting, and tRPC endpoints

**Files:**
- Create: `src/github/gh-runner.ts`, `src/github/issue-map.ts`, `src/github/issue-sync.ts`
- Modify: `src/config/runtime-config.ts` (project config shape at `:24`, `RuntimeConfigState`, update/save paths), `src/core/api-contract.ts` (config response/update schemas; new request/response schemas below), `src/server/runtime-state-hub.ts:300` (trigger), `src/cli.ts:361` (wire service + startup sync), `src/trpc/workspace-api.ts`, `src/trpc/app-router.ts` (`workspace` router at `:747`)
- Test: `test/runtime/github/issue-sync.test.ts`, `test/runtime/github/issue-map.test.ts`, plus the existing runtime-config test file for the new field

**Interfaces:**
- Produces:
  - `type GhRunner = (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>`; `runGh: GhRunner` (rejects on non-zero exit / ENOENT).
  - `interface GithubIssueEntry { issueNumber?: number; issueUrl?: string; syncedColumn?: RuntimeBoardColumnId; closed?: boolean; summary?: string; skipped?: boolean }`; `type GithubIssueMap = Record<string, GithubIssueEntry>`.
  - `readGithubIssueMap(workspaceId: string): Promise<GithubIssueMap>`; `setGithubIssueSummary(workspaceId: string, taskId: string, summary: string): Promise<void>` (locked; trims; empty → no-op).
  - `reconcileGithubIssues(input: { workspaceId: string; repoPath: string }, deps: GithubIssueSyncDeps): Promise<GithubIssueSyncResult>` where `GithubIssueSyncResult = { ok: boolean; created: number; updated: number; closed: number; error?: string }`.
  - `createGithubIssueSyncService(deps: GithubIssueSyncDeps): { requestSync(workspaceId: string, repoPath: string): void; syncNow(workspaceId: string, repoPath: string): Promise<GithubIssueSyncResult> }`.
  - `RuntimeConfigState.githubIssueSyncEnabled: boolean` (project-scoped), accepted by the existing `runtime.saveConfig` update input.
  - tRPC `workspace.setTaskIssueSummary` mutation `{ taskId: string; summary: string } → { ok: true }`; `workspace.syncGithubIssues` mutation `→ GithubIssueSyncResult`; `workspace.getGithubIssues` query `→ { enabled: boolean; issues: Record<string, { number: number; url: string }> }` (open and closed issues).

- [ ] **Step 1: Write failing tests for `reconcileGithubIssues`** with a fake runner that records argv and returns `https://github.com/o/r/issues/<n>` for `issue create`:
  - `does nothing when disabled` → zero runner calls.
  - `creates issue for backlog task` → argv `["issue","create","--title",<title>,"--body",<body>,"--label","kanban: backlog"]`; body equals `"<summary>\n\n---\nKanban task: <id>"` when a summary exists, `"Kanban task: <id>"` otherwise; body never contains the prompt string; mapping gets `issueNumber`, `issueUrl`, `syncedColumn: "backlog"`.
  - `ensures labels before first use` → `["label","create",<label>,"--force", ...]` precedes `issue create`/`issue edit` once per run.
  - `column move swaps label and comments` → `issue edit <n> --add-label "kanban: in progress" --remove-label "kanban: backlog"` then `issue comment <n> --body "Moved to In progress (agent: codex)"` (omit ` (agent: …)` when the card has no `agentId`).
  - `done with commit` → `issue comment <n> --body "Done in commit <sha>"` (sha from the latest `pass` event with `commit`), `issue edit` removing the status label, `issue close <n> --reason completed`; `closed: true`.
  - `done without commit` → comment `Moved to Done`, then close completed.
  - `task back from done reopens` → `issue reopen <n>`, add label for the new column, comment `Reopened, moved to <Column title>`.
  - `deleted open task closes not planned` → `issue close <n> --reason "not planned"`; entry kept with `closed: true`. `deleted closed task` → no call.
  - `backfill skips done` → task first seen in `trash` with no entry → `skipped: true`, no call. Entry with `summary` only, task now in `trash` → issue created then closed (offline-created case).
  - `summary-only entry is ignored` → entry whose task id is not on the board and has no `issueNumber` → no call, entry untouched.
  - `reconcile aborts on gh error and keeps mapping` → runner rejects on first call → `{ ok:false, error }`, mapping file unchanged for that task, `warn` called once.
  - `passes title and body as single argv elements` → title `a "b" $(c)\nd` arrives as one element.
- [ ] **Step 2:** `npx vitest run test/runtime/github` → FAIL (modules missing).
- [ ] **Step 3: Implement `gh-runner.ts`, `issue-map.ts`, `issue-sync.ts`.** Mapping file at `join(getWorkspaceDirectoryPath(workspaceId), "github-issues.json")`, read/written with `lockedFileSystem`; the whole reconcile holds the mapping-file lock. Board from `loadWorkspaceBoardById`, history from `loadTaskHistory`, enabled flag from `loadRuntimeConfig(repoPath).githubIssueSyncEnabled`. A task seen in an open column with no entry gets an entry before its `gh` call (so a failed create still marks it "seen open"). Column titles in comments: `Backlog`, `In progress`, `Review`, `Done`. Process tasks sequentially; persist the mapping after each successful task step so a later failure keeps earlier progress.
- [ ] **Step 4:** `npx vitest run test/runtime/github` → PASS.
- [ ] **Step 5: Service coalescing test** `concurrent requestSync creates one issue`: two `requestSync` calls + one `syncNow` while a slow fake runner is in flight → exactly one `issue create`; `syncNow` resolves with the result of a run that started after it was called. Implement: one in-flight run per workspace, at most one queued rerun.
- [ ] **Step 6: Setting.** Test in the runtime-config tests: project config `{ "githubIssueSyncEnabled": true }` → `loadRuntimeConfig` returns `true`; missing → `false`; `updateRuntimeConfig(cwd, { githubIssueSyncEnabled: true })` writes it to the project config file (not the global one). Implement, threading the field through `api-contract.ts` config schemas.
- [ ] **Step 7: Wiring.** In `runtime-state-hub.ts` add optional dep `onWorkspaceStateChanged?: (workspaceId: string, workspacePath: string) => void`, called at the top of `broadcastRuntimeWorkspaceStateUpdated` **before** the no-clients early return. In `src/cli.ts` create the service with `runGh` and pass `requestSync` into the hub; on startup call `requestSync` for each `listWorkspaceIndexEntries()` entry (the reconcile itself checks the setting). Add the three tRPC procedures (`syncGithubIssues` calls `syncNow`). Test: hub test asserting the callback fires with zero clients connected.
- [ ] **Step 8:** `npm run typecheck && npm run lint && npm run test:fast` → all pass.
- [ ] **Step 9: Commit** `feat: sync Kanban tasks to GitHub issues for opted-in projects`.

### Task 2: CLI `--summary` and sidebar prompt

**Files:**
- Modify: `src/commands/task.ts` (`createTask` at `:764`, the `task create` option parser), `src/prompts/append-system-prompt.ts:211-216` (`task create` reference)
- Test: the existing `task create` command tests and the append-system-prompt test file

**Interfaces:**
- Consumes: tRPC `workspace.setTaskIssueSummary` (Task 1); `addTaskToColumn(..., explicitTaskId)` in `src/core/task-board-mutations.ts:291-308`.

- [ ] **Step 1: Failing tests:**
  - `task create --summary passes summary before creating the task` → fake runtime client records `setTaskIssueSummary({ taskId, summary })` called **before** the board mutation, and the created task's id equals that `taskId`.
  - `task create without --summary does not call setTaskIssueSummary`.
  - `--summary` whitespace-only → not sent.
  - Prompt test: the `task create` line contains `[--summary "<text>"]`, and the notes say: when the project has GitHub issue sync on, pass a 1–3 sentence lecturer-facing summary with no file paths, no `contexte/` content, no secrets.
- [ ] **Step 2:** run those tests → FAIL.
- [ ] **Step 3: Implement.** Pre-generate the id with the same `createUniqueTaskId` path (pass it as `explicitTaskId`), call `setTaskIssueSummary` first (if it throws, warn to stderr and continue creating the task), then mutate. Add the flag to the parser and help text.
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` → pass.
- [ ] **Step 5: Commit** `feat(cli): task create --summary for GitHub issue body`.

### Task 3: Web UI — toggle, Sync now, summary field, card issue link

**Files:**
- Modify: `web-ui/src/components/runtime-settings-dialog.tsx` (project section), `web-ui/src/components/task-create-dialog.tsx`, the create-task call site in `web-ui/src/App.tsx` / its hook, `web-ui/src/components/board-card.tsx`
- Create: one hook, e.g. `web-ui/src/hooks/use-github-issues.ts`, that queries `workspace.getGithubIssues` and refetches on `workspace_state_updated`
- Test: `runtime-settings-dialog.test.tsx`, a `task-create-dialog` test, `board-card.test.tsx`, the new hook's test

**Interfaces:**
- Consumes (Task 1): `RuntimeConfigState.githubIssueSyncEnabled` + `runtime.saveConfig`; `workspace.syncGithubIssues`; `workspace.setTaskIssueSummary`; `workspace.getGithubIssues`.

- [ ] **Step 1: Failing tests:**
  - Settings: switch labeled `Sync tasks to GitHub issues` reflects and saves `githubIssueSyncEnabled`; `Sync now` button (enabled only when the switch is on) calls `syncGithubIssues` and shows a success toast, or a toast with `error` when `ok:false`.
  - Create dialog: `Issue summary` textarea is absent when sync is off and present when on; with a summary, `setTaskIssueSummary` is called with the same id the new card gets, **before** the board save; without, it is not called. The field is hidden in multi-task create mode.
  - Card: with an issue `{ number: 12, url }` the card shows `#12`; clicking opens `url` through the app's existing external-link path (see how `project-navigation-panel.tsx` / `runtime-settings-dialog.tsx` open external URLs) and does not open the card; no issue → nothing shown.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3: Implement.** Use Radix Switch, `Button`, `showAppToast`, design tokens per AGENTS.md; `#12` as a small `text-text-secondary` link on the card's meta line. Pre-generate the task id in the create path so the summary call can precede the board save; do not add any card field (AGENTS.md board-state rebuild warning).
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` → pass (include web-ui tests).
- [ ] **Step 5: Commit** `feat(web-ui): GitHub issue sync toggle, summary field, card issue link`.

## Order

Task 1 first. Tasks 2 and 3 both depend only on Task 1 and can run in parallel.
