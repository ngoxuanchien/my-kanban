# Superseded by 2026-10-29-remove-agent-review-design.md

# Agent Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a task with Agent review on reaches Review, a Kanban-run reviewer agent checks it server-side, sends fix prompts to the task agent for up to 3 rounds, and then either commits it and moves it to Done with a summary, or moves it to a new **Needs your review** column.

**Architecture:** One `AgentReviewService` per workspace in the runtime process. It watches task-session summaries, drives a pure state reducer (`reduceAgentReview`), runs a one-shot reviewer subprocess (or a Cline SDK session) in the task worktree with a git snapshot before and after, and saves all agent-review state on the card in `board.json` through `mutateWorkspaceState`. The browser only shows that state and stays out of the loop for agent-review cards.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), zod, vitest, `tree-kill`, git CLI via `runGit`, React + Tailwind v4 + Radix in `web-ui`.

**Spec:** `docs/superpowers/specs/2026-10-28-agent-review-design.md`

---

## ⚠️ Open questions for the user (answer before the marked steps)

**Q1 (spec §7): review passes but the card's auto-commit is off. What should happen?**

| Option | Behavior | Effect on this plan |
|---|---|---|
| **Spec's current call** | Card stays in Review with status `passed` and the summary shown. The user commits and moves it. | Task 10, Step 1 uses assertion **Q1-A**. |
| (a) | Always commit after a pass, even with auto-commit off (use `"commit"` mode). | Task 10, Step 1 uses assertion **Q1-B**. |
| (b) | Move to Done anyway (uncommitted work is deleted). The spec advises against it. | Task 10, Step 1 uses assertion **Q1-C**. |

Only the one test marked `BLOCKED ON Q1` in Task 10 and the matching reducer branch depend on this. Every other step can go ahead. **Do not merge Task 10 until Q1 is answered.**

**Note on the spec header:** the file still says `Status: draft for the user to approve`. You told me it is approved, so this plan treats it as approved. You may want to update the header.

---

## Global Constraints

- Round limit: **3 fix prompts**. The 4th failed review goes to `user_review` (spec §4.4). Constant `AGENT_REVIEW_MAX_FIX_ROUNDS = 3`.
- New column id `user_review`, title **`Needs your review`**, placed between `review` and `trash`.
- New card fields load as off/absent. `agentReviewEnabled` defaults to **off** for new and existing cards.
- Global setting `reviewerAgent`: `"same_as_task"` (default) or a `RuntimeAgentId`. "Same as task" = `card.agentId ?? runtimeConfig.selectedAgentId`.
- At most **1 reviewer run per workspace** at a time. Other runs wait in a FIFO queue.
- Reviewer timeout: `REVIEWER_RUN_TIMEOUT_MS = 20 * 60_000`. Commit step timeout: `COMMIT_STEP_TIMEOUT_MS = 10 * 60_000`. Not user-configurable in v1.
- No timeout on the task agent's own fix turn.
- Nothing about agent review is written inside the task worktree. Results live on the card.
- Tasks **without** `agentReviewEnabled` behave exactly as today, including browser-only auto-commit.
- No `any`. No inline/dynamic imports (AGENTS.md). Share runtime code with web-ui through `@runtime-*` aliases (vite, vitest and tsconfig all three), as `@runtime-task-state` does today.
- Agent launches use a direct `spawn` with an inherited env. Never through an interactive shell (AGENTS.md).
- Verification for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast` (runtime) and/or `npm run web:typecheck && npm run web:test` (web-ui) must pass.

## Decisions this plan makes for items the spec left to the builder (§6)

Veto any of these before execution starts:

1. **Card state shape:** a single `agentReview` object per card. It keeps the latest result plus the list of fix prompts sent so far, not a full history of every round.
2. **Reviewer process:** a one-shot non-interactive CLI subprocess per agent, with the prompt on stdin and stdout captured. Cline uses a Cline SDK session keyed `agent-review:<taskId>`. The reviewer never uses `TerminalSessionManager`.
3. **Structured output:** JSON between `<<<KANBAN_AGENT_REVIEW_RESULT` and `KANBAN_AGENT_REVIEW_RESULT>>>` in the final output. The last block wins.
4. **Read-only inside the agent:** per-agent flags where they exist, plus prompt rules. The runtime snapshot check (Task 5) is the real line.
5. **Reviewer agent choices:** `same_as_task` plus `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`. Others resolve to `reviewer_agent_unavailable`.
6. **User input detection:** at the input boundaries (`ws-server` terminal input, tRPC `sendTaskSessionInput` / `sendTaskChatMessage`). The orchestrator calls the session services in-process, so it never passes through those boundaries and needs no tag. xterm's automatic terminal replies are not counted as user input.
7. **PTY submit:** `ESC[200~` + text + `ESC[201~`, wait 200 ms, then `\r`. This is the same as the browser path today.
8. **No desktop notification** in v1. The card landing in **Needs your review** is the signal. Add one later by reusing `readyForReviewNotificationsEnabled`.
9. **More than one reviewer across different workspaces:** allowed (the queue is per workspace).
10. **Reviewer live output:** not shown in v1. The status badge and the stored result are enough.

## Review Focus

Inputs and conditions the spec implies but does not spell out. Each line has a test in the owning task.

1. **The browser strips the new card fields.** `web-ui/src/state/board-state.ts` `normalizeCard` keeps only known fields. If `agentReviewEnabled` and `agentReview` are not kept, the next browser save wipes the runtime's state. → Task 13 test `normalizeBoardData keeps agentReviewEnabled and agentReview`.
2. **xterm auto-replies counted as user input.** Focus events (`ESC[I`, `ESC[O`) and cursor/device reports (`ESC[12;5R`, `ESC[?1;2c`) arrive on the same WebSocket as keystrokes. Counting them would reset rounds and throw away reviewer runs. → Task 8 test `isTerminalAutoReply`.
3. **Card deleted, moved to Done or toggled off while a reviewer runs.** The run must be killed, its result dropped, and no write may bring the card back. → Task 11 test `drops reviewer result when the card left review mid-run`.
4. **Reviewer output that is messy.** Two result blocks, JSON inside a ```` ```json ```` fence, or prose after the block. The last valid block wins. No block → `reviewer_bad_output`. → Task 6 tests.
5. **The diff cannot be computed.** For example, `baseRef` was deleted, or the merge-base is missing. This must go to `user_review` with reason `reviewer_crashed` and detail. It must not count as an empty diff and must not crash the service loop. → Task 5 test `throws AgentReviewGitError` + Task 11 test `diff failure goes to user_review`.

---

## Task graph

```
Wave 0 (start in parallel):  T1  T3  T5  T7  T8
Wave 1 (after T1):           T2  T4  T6  T10  T13
Wave 2:                      T11 (after T1–T8, T10)    T14 (after T3, T13)
Wave 3:                      T12 (after T11)
```

| Task | Depends on | Parallel with | Notes |
|---|---|---|---|
| T1 Contract, board load, config | – | T3 T5 T7 T8 | Foundation for most tasks |
| T2 Board mutations, counts, CLI | T1 | T4 T6 T10 T13 | Touches `src/commands/task.ts` (columns/flags) |
| T3 Shared git-action prompt | – | all of wave 0 | web-ui + runtime |
| T4 Shared Done routine | T1 | T2 T6 T10 T13 | Touches `src/commands/task.ts` (`trashTaskById` only). Merge after T2. |
| T5 Worktree snapshot, diff, fingerprint | – | wave 0 | Pure git |
| T6 Reviewer prompt + output parser | T1 | wave 1 | |
| T7 Reviewer runner | – | wave 0 | |
| T8 Task session signals and sender | – | wave 0 | |
| T10 Agent-review reducer | T1 | wave 1 | One test blocked on Q1 |
| T11 Agent-review service | T1 T2 T3 T4 T5 T6 T7 T8 T10 | T14 | Critical path |
| T12 Runtime wiring + integration test | T11 | – | |
| T13 web-ui columns, types, browser hands-off | T1 | wave 1 | |
| T14 web-ui toggles, settings, status display | T3 T13 | T11 T12 | |

(There is no T9. Turn-end classification is part of T8.)

---

### Task 1: Contract, board load, and runtime config

**Files:**
- Modify: `src/core/api-contract.ts` (column enum line 77, `runtimeBoardCardSchema` line 132, `runtimeProjectTaskCountsSchema` line 330, `runtimeConfigResponseSchema` / `runtimeConfigSaveRequestSchema` ~line 940)
- Modify: `src/state/workspace-state.ts` (`BOARD_COLUMNS` line 34, `readWorkspaceBoard` line 295)
- Modify: `src/config/runtime-config.ts` (state, update input, load/save/normalize, same pattern as `commitPromptTemplate`)
- Modify: `src/trpc/runtime-api.ts` (config save handler passes `reviewerAgent` through)
- Test: `test/runtime/api-validation.test.ts`, `test/runtime/config/runtime-config.test.ts`, `test/integration/workspace-state.integration.test.ts`

**Interfaces:**
- Produces (all exported from `src/core/api-contract.ts`):
  - `RuntimeBoardColumnId` now includes `"user_review"`. Enum order: `["backlog","in_progress","review","user_review","trash"]`.
  - `runtimeAgentReviewStatusSchema = z.enum(["queued","reviewing","fixing","committing","passed","no_changes","needs_user"])`
  - `runtimeAgentReviewReasonSchema = z.enum(["round_limit","cannot_verify","reviewer_crashed","reviewer_timeout","reviewer_bad_output","reviewer_modified_worktree","reviewer_agent_unavailable","task_agent_not_running","commit_failed"])`
  - `runtimeAgentReviewSummarySchema = z.object({ whatWasDone, whatItAffects, againstRequest, howVerified, risks })` (all `z.string()`)
  - `runtimeAgentReviewResultSchema = z.object({ verdict: z.enum(["pass","fail","cannot_verify"]), appVerified: z.boolean(), appCheck: z.string(), tests: z.array(z.object({ command: z.string(), result: z.string() })), summary: runtimeAgentReviewSummarySchema.nullable(), fixPrompt: z.string().nullable(), notes: z.string().nullable() })`
  - `runtimeAgentReviewMetaSchema = z.object({ commitHash: z.string().nullable(), prUrl: z.string().nullable(), rounds: z.number().int().min(0), reviewerAgentId: runtimeAgentIdSchema, reviewedAt: z.number() })`
  - `runtimeAgentReviewStateSchema = z.object({ status, round: z.number().int().min(0), reason: runtimeAgentReviewReasonSchema.nullable(), reasonDetail: z.string().nullable(), fingerprint: z.string().nullable(), lastResult: runtimeAgentReviewResultSchema.nullable(), fixPrompts: z.array(z.string()), summary: runtimeAgentReviewSummarySchema.nullable(), meta: runtimeAgentReviewMetaSchema.nullable(), updatedAt: z.number() })`
  - Inferred types `RuntimeAgentReviewStatus`, `RuntimeAgentReviewReason`, `RuntimeAgentReviewSummary`, `RuntimeAgentReviewResult`, `RuntimeAgentReviewMeta`, `RuntimeAgentReviewState`
  - `runtimeBoardCardSchema` gains `agentReviewEnabled: z.boolean().optional()` and `agentReview: runtimeAgentReviewStateSchema.optional()`
  - `runtimeReviewerAgentSettingSchema = z.union([z.literal("same_as_task"), runtimeAgentIdSchema])`. `reviewerAgent` added to config response (required) and save request (optional).
  - `RuntimeProjectTaskCounts` gains `user_review: number`
  - `RuntimeConfigState.reviewerAgent: RuntimeReviewerAgentSetting` (default `"same_as_task"`, saved to global config only when not default, like `commitPromptTemplate`)

- [ ] **Step 1: Write failing tests**

`test/runtime/api-validation.test.ts`:
```ts
it("parses user_review column and keeps legacy done→trash mapping", () => {
  expect(runtimeBoardColumnIdSchema.parse("user_review")).toBe("user_review");
  expect(runtimeBoardColumnIdSchema.parse("done")).toBe("trash");
});
it("loads a card without agent review fields as off", () => {
  const card = runtimeBoardCardSchema.parse({ id: "a", prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 });
  expect(card.agentReviewEnabled).toBeUndefined();
  expect(card.agentReview).toBeUndefined();
});
it("round-trips a card with agentReview state", () => { /* parse(full state) toEqual input */ });
it("rejects agentReview with negative round", () => { expect(() => runtimeAgentReviewStateSchema.parse({ ...valid, round: -1 })).toThrow(); });
```
`test/runtime/config/runtime-config.test.ts`:
```ts
it("defaults reviewerAgent to same_as_task and does not write it to disk", ...);
it("saves and reloads reviewerAgent = codex", ...);
```
`test/integration/workspace-state.integration.test.ts`:
```ts
it("adds a missing user_review column on load, between review and trash", async () => {
  // write board.json with the 4 old columns (one card in review) → loadWorkspaceState
  expect(state.board.columns.map((c) => c.id)).toEqual(["backlog","in_progress","review","user_review","trash"]);
  expect(state.board.columns[3].title).toBe("Needs your review");
  expect(state.board.columns[2].cards).toHaveLength(1);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run test/runtime/api-validation.test.ts test/runtime/config/runtime-config.test.ts test/integration/workspace-state.integration.test.ts`
Expected: FAIL (`user_review` invalid enum value, `reviewerAgent` undefined, column count 4).

- [ ] **Step 3: Implement**

Add the schemas above. Add `{ id: "user_review", title: "Needs your review" }` to `BOARD_COLUMNS`. Add `ensureBoardColumns(board: RuntimeBoardData): RuntimeBoardData` in `workspace-state.ts`, applied in `readWorkspaceBoard`. It rebuilds `columns` in `BOARD_COLUMNS` order, keeps existing cards, and adds empty missing columns. Wire `reviewerAgent` through runtime-config and the tRPC config save handler.

- [ ] **Step 4: Run the tests and confirm they pass, then run the full checks**

Run: the Step 2 command, then `npm run typecheck && npm run test:fast`
Expected: PASS. Typecheck errors in other files that switch over `RuntimeBoardColumnId` belong to T2/T13. If typecheck fails only there, add the minimal `"user_review"` case needed to compile, and nothing more.

- [ ] **Step 5: Commit**: `feat(agent-review): add contract, user_review column and reviewerAgent config`

---

### Task 2: Board mutations, project counts, and CLI

**Files:**
- Modify: `src/core/task-board-mutations.ts:213` (`getLinkedBacklogTaskIdsReadyAfterTaskTrashed`), `RuntimeCreateTaskInput` / `RuntimeUpdateTaskInput` (+`agentReviewEnabled`)
- Modify: `src/server/workspace-registry.ts:95-100` (counts)
- Modify: `src/commands/task.ts` (`LIST_TASK_COLUMNS` line 30, column parser ~line 66, `columnCanHaveLiveTaskSession` line 780, `formatTaskRecord`, create/update options ~lines 1126/1186)
- Modify: `man/kanban.1` if it lists columns/flags
- Test: `test/runtime/task-board-mutations.test.ts`, `test/integration/cli-compat.integration.test.ts`

**Interfaces:**
- Consumes: T1 column id and card fields.
- Produces: `createTask` / `updateTask` accept `agentReviewEnabled?: boolean`. CLI JSON task records include `agentReviewEnabled: boolean` and `agentReview: RuntimeAgentReviewState | null`.

- [ ] **Step 1: Write failing tests**

`task-board-mutations.test.ts`:
```ts
it("starts linked backlog tasks when a task is trashed from user_review", () => {
  // board with dependency backlog B → A, A in user_review
  expect(trashTaskAndGetReadyLinkedTaskIds(board, "A").readyTaskIds).toEqual(["B"]);
});
it("does not start linked tasks when a task is trashed from in_progress", ...); // keeps today's behavior
it("updateTask sets agentReviewEnabled", ...);
```
`cli-compat.integration.test.ts`:
```ts
it("task list --column needs_review is an alias for user_review", ...);
it("task create --agent-review-enabled stores agentReviewEnabled true and prints it", ...);
it("task trash works from user_review and stops the session", ...);
```

- [ ] **Step 2: Run them and confirm they fail.** `npx vitest run test/runtime/task-board-mutations.test.ts test/integration/cli-compat.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Allow `fromColumnId` of `"review"` or `"user_review"`. Add `user_review` to counts and `LIST_TASK_COLUMNS`. Map `needs_review` → `user_review` in the parser and update the error message. `columnCanHaveLiveTaskSession` returns true for `user_review`. Add the `--agent-review-enabled [value]` option, parsed with `parseOptionalBooleanOption` like `--auto-review-enabled`.
- [ ] **Step 4: Run the tests and confirm they pass.** Same command, then `npm run typecheck && npm run test:fast`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): support user_review in board mutations, counts and CLI`

---

### Task 3: Share the git-action prompt builder with the runtime

**Files:**
- Create: `src/core/task-git-action-prompt.ts` (moved from `web-ui/src/git-actions/build-task-git-action-prompt.ts`)
- Modify: `web-ui/src/git-actions/build-task-git-action-prompt.ts` → re-export from `@runtime-task-git-action-prompt`, or delete it and update importers (`use-git-actions.ts`, `use-review-auto-actions.ts`, the test). Pick whichever leaves fewer files.
- Modify: `web-ui/vite.config.ts`, `web-ui/vitest.config.ts`, `web-ui/tsconfig.json` (add alias `@runtime-task-git-action-prompt`)
- Move test: `web-ui/src/git-actions/build-task-git-action-prompt.test.ts` → `test/runtime/task-git-action-prompt.test.ts`

**Interfaces:**
- Produces: `buildTaskGitActionPrompt(input: { action: "commit" | "pr"; baseRef: string; templates?: TaskGitPromptTemplates | null }): string`, `TaskGitAction`, `TaskGitPromptTemplates`, `TASK_GIT_BASE_REF_PROMPT_VARIABLE`. **Change:** the input takes `baseRef: string` instead of `workspaceInfo`, because the runtime has no `RuntimeTaskWorkspaceInfoResponse`. Web-ui callers pass `workspaceInfo.baseRef`.

- [ ] **Step 1:** Move the existing tests to `test/runtime/task-git-action-prompt.test.ts`, switch them to `baseRef`, and add `it("replaces every {{base_ref}} occurrence")`.
- [ ] **Step 2:** `npx vitest run test/runtime/task-git-action-prompt.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Move the code and add the aliases. The behavior stays the same apart from the `baseRef` input.
- [ ] **Step 4:** `npx vitest run test/runtime/task-git-action-prompt.test.ts && npm run web:typecheck && npm run web:test -- use-git-actions use-review-auto-actions`. Expected: PASS.
- [ ] **Step 5: Commit**: `refactor: share task git action prompt between runtime and web-ui`

---

### Task 4: Shared "move to Done" routine

**Files:**
- Create: `src/workspace/complete-task-to-done.ts`
- Modify: `src/commands/task.ts` `trashTaskById` (line 784) to call it with tRPC-backed deps
- Test: `test/runtime/complete-task-to-done.test.ts`

**Interfaces:**
- Consumes: `mutateWorkspaceState`, `trashTaskAndGetReadyLinkedTaskIds`, `getTaskColumnId`.
- Produces:
```ts
export interface CompleteTaskToDoneDeps {
  stopTaskSession(taskId: string): Promise<void>;
  startTask(taskId: string): Promise<unknown>;          // result is passed through to autoStartedTasks
  deleteTaskWorktree(taskId: string): Promise<{ removed: boolean; error?: string }>;
  notifyStateUpdated(): Promise<void>;
}
export interface CompleteTaskToDoneResult {
  previousColumnId: RuntimeBoardColumnId | null; alreadyInTrash: boolean;
  readyTaskIds: string[]; autoStartedTasks: unknown[];
  worktreeDeleted: boolean; worktreeDeleteError?: string;
  task: RuntimeBoardCard | null;
}
export async function completeTaskToDone(input: {
  repoPath: string; taskId: string; deps: CompleteTaskToDoneDeps;
  beforeMove?: (card: RuntimeBoardCard) => RuntimeBoardCard; // runtime uses this to write meta in the same mutation
}): Promise<CompleteTaskToDoneResult>
```
Order (same as `trashTaskById` today): mutate the board (apply `beforeMove`, move to trash) → notify → stop the session if the previous column was `in_progress | review | user_review` → start ready dependents → delete the worktree.

- [ ] **Step 1: Write failing tests** with a temp workspace (`test/utilities/temp-dir.ts`) and fake deps that record calls:
  - `it("moves the card to trash, then stops the session, starts dependents, deletes the worktree, in that order")`: assert the call-order array equals `["notify","stop","start:B","delete"]`.
  - `it("applies beforeMove inside the same board write")`: the card in trash has `agentReview.meta.commitHash === "abc123"`, and the revision goes up by exactly 1.
  - `it("is a no-op when the task is already in trash")`: `alreadyInTrash: true`, no deps called.
  - `it("starts dependents when moved from user_review")`.
- [ ] **Step 2:** `npx vitest run test/runtime/complete-task-to-done.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement and refactor `trashTaskById` to use it. Keep the CLI output shape (`TrashTaskExecutionResult`) unchanged.
- [ ] **Step 4:** Same command + `npx vitest run test/integration/task-command-exit.integration.test.ts test/integration/cli-compat.integration.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**: `refactor: extract shared completeTaskToDone routine`

---

### Task 5: Worktree snapshot, diff check, and content fingerprint

**Files:**
- Create: `src/workspace/agent-review-git.ts`
- Test: `test/runtime/workspace/agent-review-git.test.ts` (real temp git repos, `test/utilities/git-env.ts`)

**Interfaces:**
- Consumes: `runGit` / `getGitStdout` from `src/workspace/git-utils.ts`.
- Produces:
```ts
export class AgentReviewGitError extends Error {}
export interface WorktreeSnapshot { head: string; branch: string | null; stashList: string; files: Record<string, string> } // path → porcelain status + content hash
export async function captureWorktreeSnapshot(cwd: string): Promise<WorktreeSnapshot>;
export function diffWorktreeSnapshots(before: WorktreeSnapshot, after: WorktreeSnapshot): string[]; // changed paths, plus "HEAD", "branch", "stash" markers
export async function computeTaskReviewFingerprint(input: { cwd: string; baseRef: string }): Promise<{ hasChanges: boolean; fingerprint: string }>;
```
`files` covers `git status --porcelain=v1 -z --untracked-files=all` (ignored files excluded) with `git hash-object` of each changed/untracked path (deleted → `"deleted"`). `computeTaskReviewFingerprint` = sha256 over `git merge-base HEAD <baseRef>`, and the tree of a temporary index holding `HEAD` + working tree + untracked-non-ignored. Use `GIT_INDEX_FILE` pointed at a temp file outside the worktree, then `git add -A` + `git write-tree`. `hasChanges` = that tree ≠ merge-base tree. Any git failure → throw `AgentReviewGitError` with the git message.

- [ ] **Step 1: Write failing tests**
  - `it("snapshot diff is empty when nothing changed")`
  - `it("detects a modified tracked file, a new untracked file, a new commit, a branch switch and a new stash")`: one case each, asserting the exact paths/markers.
  - `it("ignores changes under gitignored paths")`: write `node_modules/x` → diff `[]`.
  - `it("detects a lockfile rewrite with the same status letter")`: modify the file twice → the content hash differs.
  - `it("hasChanges is true for committed-only changes on the task branch")`: commit on the branch, clean tree → `hasChanges: true`. (This guards against a repeat of `2483d`.)
  - `it("hasChanges is false for a clean branch at the base")`
  - `it("fingerprint is the same after committing the same content")`: working change → fp1; `git commit -am` → fp2; `expect(fp2).toBe(fp1)`.
  - `it("fingerprint changes when content changes")`
  - `it("does not touch the real index")`: `git status` output is the same before and after `computeTaskReviewFingerprint`.
  - `it("throws AgentReviewGitError when baseRef does not exist")` (Review Focus 5)
- [ ] **Step 2:** `npx vitest run test/runtime/workspace/agent-review-git.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): worktree snapshot and review fingerprint`

---

### Task 6: Reviewer prompt, fix prompt, and output parser

**Files:**
- Create: `src/agent-review/reviewer-prompt.ts`, `src/agent-review/reviewer-output.ts`
- Test: `test/runtime/agent-review/reviewer-prompt.test.ts`, `test/runtime/agent-review/reviewer-output.test.ts`

**Interfaces:**
- Consumes: T1 `runtimeAgentReviewResultSchema`, `RuntimeAgentReviewResult`.
- Produces:
```ts
export const AGENT_REVIEW_RESULT_START = "<<<KANBAN_AGENT_REVIEW_RESULT";
export const AGENT_REVIEW_RESULT_END = "KANBAN_AGENT_REVIEW_RESULT>>>";
export function buildReviewerPrompt(input: { title: string; prompt: string; baseRef: string; round: number; previousFixPrompts: string[] }): string;
export function buildFixPromptMessage(input: { fixPrompt: string; round: number; maxRounds: number }): string;
export type ParsedReviewerOutput = { ok: true; result: RuntimeAgentReviewResult } | { ok: false; error: string };
export function parseReviewerOutput(output: string): ParsedReviewerOutput;
```
The reviewer prompt must contain: the title and the original prompt verbatim; how to see the diff (`git diff <merge-base>...HEAD` plus `git status` / `git diff` for the working tree); the round number and, from round 2 on, each earlier fix prompt numbered; and these rules: do not edit files; no formatters, codegen or snapshot updates; installs that respect the lockfile (`npm ci`, `pnpm install --frozen-lockfile`); find out how to run the app from package.json scripts / README / Makefile; stop every process it started; `appVerified: false` with a reason when the app cannot run for reasons outside the task, and that this is not a pass; a run failure caused by the task's change is `fail`; and the exact JSON shape between the two markers. The fix-prompt message starts with the header `[Kanban agent review — fix round {round}/{maxRounds}]`, followed by a line saying that the issues come from the Kanban reviewer and that the agent should stop when they are fixed.

- [ ] **Step 1: Write failing tests**

`reviewer-output.test.ts`:
```ts
it("parses a valid pass block", ...);
it("uses the last block when there are two", ...);                 // Review Focus 4
it("accepts JSON wrapped in a ```json fence inside the markers", ...); // Review Focus 4
it("ignores prose after the end marker", ...);
it("fails with no block", () => expect(parseReviewerOutput("done!")).toEqual({ ok: false, error: expect.stringContaining("no result block") }));
it("fails a pass without summary", ...);       // spec 4.3: summary required for pass
it("fails a fail verdict without fixPrompt", ...); // spec 4.3: fixPrompt required for fail
it("fails on invalid JSON", ...);
```
`reviewer-prompt.test.ts`:
```ts
it("includes title, verbatim prompt, baseRef and the result markers", ...);
it("lists earlier fix prompts numbered from round 2", ...);
it("omits the earlier-fixes section in round 1", ...);
it("fix message starts with '[Kanban agent review — fix round 2/3]'", ...);
```
- [ ] **Step 2:** `npx vitest run test/runtime/agent-review/`. Expected: FAIL.
- [ ] **Step 3:** Implement. Parsing: find the last start marker, take the text up to the next end marker, strip an optional code fence, `JSON.parse`, `safeParse` with the T1 schema, then apply the pass/fail extra rules.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): reviewer prompt and output parser`

---

### Task 7: Reviewer runner (one-shot process with timeout and tree kill)

**Files:**
- Create: `src/agent-review/reviewer-runner.ts`
- Test: `test/runtime/agent-review/reviewer-runner.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_AGENT_CATALOG`, `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS` (`src/core/agent-catalog.ts`), `tree-kill` (already a dependency), `ClineTaskSessionService`.
- Produces:
```ts
export type ReviewerRunOutcome =
  | { kind: "completed"; output: string }
  | { kind: "timeout" }
  | { kind: "crashed"; error: string }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: string };
export interface ReviewerRunHandle { done: Promise<ReviewerRunOutcome>; cancel(): void }
export function buildReviewerCommand(agentId: RuntimeAgentId): { binary: string; args: string[]; promptVia: "stdin" | "arg" } | null; // null = no non-interactive mode
export function startReviewerRun(input: {
  agentId: RuntimeAgentId; cwd: string; prompt: string; timeoutMs: number;
  isAgentInstalled(agentId: RuntimeAgentId): boolean;
  clineService?: ClineTaskSessionService; reviewKey: string; // "agent-review:<taskId>"
  spawnImpl?: typeof spawn; // test seam
}): ReviewerRunHandle;
```
Starting argv table. **Confirm each one against `<binary> --help` in Step 3, and record the confirmed argv in the test's expectations:**

| agent | argv | prompt |
|---|---|---|
| claude | `claude -p --output-format text --disallowedTools Edit Write NotebookEdit --allowedTools Bash Read Grep Glob` | stdin |
| codex | `codex exec -` + catalog `autonomousArgs` | stdin |
| droid | `droid exec` + catalog `autonomousArgs` | arg |
| kiro | `kiro-cli chat --no-interactive --trust-all-tools` | arg |
| cline | Cline SDK session `reviewKey`, act mode. Wait for the summary to leave `running`, read `latestHookActivity.finalMessage`, then stop the session. | – |
| others / not launch-supported / no confirmed one-shot mode | `null` → `unavailable` | – |

Spawn with `detached: true`, `cwd`, inherited env, and stdout+stderr captured (keep at most the last 1 MiB). On timeout or cancel: `treeKill(pid, "SIGKILL")`. A non-zero exit with no output → `crashed`. A non-zero exit *with* output → `completed` (the parser decides).

- [ ] **Step 1: Write failing tests** using a fake agent script (a small `node -e` script written to a temp dir, passed through `spawnImpl` or a PATH override):
  - `it("returns completed with stdout")`
  - `it("times out and kills the whole process tree")`: the fake spawns a grandchild `node -e "setInterval(()=>{},1000)"` and prints its pid. After the timeout, `process.kill(grandPid, 0)` throws.
  - `it("cancel() resolves cancelled and kills the tree")`
  - `it("returns unavailable when the agent is not installed")`
  - `it("returns unavailable for gemini (not launch-supported)")`
  - `it("buildReviewerCommand matches the confirmed argv table")`
  - `it("cline run uses reviewKey, never the task id")`: a fake `ClineTaskSessionService` records `startTaskSession` → `taskId === "agent-review:t1"`.
- [ ] **Step 2:** `npx vitest run test/runtime/agent-review/reviewer-runner.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Confirm the argv table (`claude --help`, `codex exec --help`, `droid exec --help`, `kiro-cli chat --help`) and implement. If a flag does not exist, use the closest read-only option, or return `null` for that agent and say so in the commit message.
- [ ] **Step 4:** Same command. Expected: PASS, with no leftover processes (`pgrep -f setInterval` is empty).
- [ ] **Step 5: Commit**: `feat(agent-review): one-shot reviewer runner with timeout tree kill`

---

### Task 8: Task session signals (turn end, user input) and prompt sender

**Files:**
- Create: `src/agent-review/task-session-signals.ts`, `src/agent-review/send-prompt-to-task.ts`
- Modify: `src/terminal/ws-server.ts:444` and `src/trpc/runtime-api.ts` (`sendTaskSessionInput` line 350, `sendTaskChatMessage` line 589): call an optional `onTaskUserInput?(workspaceId, taskId)` dep after a successful write
- Modify: `src/server/runtime-state-hub.ts`: do not broadcast Cline summaries whose `taskId` starts with `agent-review:`
- Test: `test/runtime/agent-review/task-session-signals.test.ts`, `test/runtime/agent-review/send-prompt-to-task.test.ts`, extend `test/runtime/trpc/runtime-api.test.ts` and `test/runtime/terminal/ws-server.test.ts`

**Interfaces:**
- Produces:
```ts
export type TurnEndKind = "turn_end" | "needs_user" | "other";
export function classifyTurnEnd(summary: RuntimeTaskSessionSummary): TurnEndKind;
export function isTerminalAutoReply(data: Buffer): boolean;
export type SendPromptResult = { ok: true } | { ok: false; reason: "task_agent_not_running" };
export async function sendPromptToTask(input: {
  taskId: string; prompt: string; agentId: RuntimeAgentId | null;
  terminalManager: TerminalSessionManager; clineService: ClineTaskSessionService;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SendPromptResult>;
export const AGENT_REVIEW_SESSION_KEY_PREFIX = "agent-review:";
```
`classifyTurnEnd` returns `turn_end` when `state === "awaiting_review"` and either (`reviewReason === "hook"` and `latestHookActivity.hookEventName` is one of `Stop`, `stop`, `TaskComplete`, `SubagentStop`, or null with `source` in `codex|opencode`), or (`reviewReason === "exit"` and `exitCode === 0`). Read each adapter in `src/terminal/agent-session-adapters.ts` to confirm the event names. It returns `needs_user` for `reviewReason === "attention"` or the hook events `PermissionRequest` / `Notification` / notification type `user_attention`. Everything else is `other`.

`sendPromptToTask`: for Cline, `sendTaskSessionInput(taskId, prompt, "act")`. If that returns null, `rebindPersistedTaskSession` once and retry. For PTY, `writeInput(ESC[200~ + prompt + ESC[201~)`, `sleep(200)`, `writeInput("\r")`. A null at any point → `task_agent_not_running`.

`isTerminalAutoReply`: true when the whole buffer is one or more of `ESC[I`, `ESC[O`, `ESC[<n>;<n>R`, `ESC[?…c`, `ESC[>…c`, or OSC replies `ESC]…(BEL|ESC\)`. `ws-server` skips `onTaskUserInput` for those.

- [ ] **Step 1: Write failing tests**
  - `classifyTurnEnd`: one case per agent turn-end event, `PermissionRequest` → `needs_user`, `exit` code 0 → `turn_end`, code 1 → `other`, `interrupted` → `other`.
  - `isTerminalAutoReply`: `"\x1b[I"` true, `"\x1b[12;5R"` true, `"\x1b[?1;2c"` true, `"a"` false, `"\x1b[Ia"` false, `"\r"` false. (Review Focus 2)
  - `sendPromptToTask`: the PTY write sequence equals `["\x1b[200~fix\x1b[201~", "\r"]`. Cline rebinds once, then succeeds. A dead session → `{ ok: false, reason: "task_agent_not_running" }`.
  - `runtime-api.test.ts`: `it("calls onTaskUserInput after sendTaskChatMessage succeeds")`. `ws-server.test.ts`: `it("does not report focus-event input as user input")`.
  - `runtime-state-hub` test (add to an existing hub test, or a new `test/runtime/server/runtime-state-hub-agent-review.test.ts`): an `agent-review:t1` summary is not in `task_sessions_updated`.
- [ ] **Step 2:** `npx vitest run test/runtime/agent-review test/runtime/trpc/runtime-api.test.ts test/runtime/terminal/ws-server.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command + `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): task session signals and runtime prompt sender`

---

### Task 10: Agent-review reducer (pure state machine)

**Files:**
- Create: `src/agent-review/agent-review-reducer.ts`
- Test: `test/runtime/agent-review/agent-review-reducer.test.ts`

**Interfaces:**
- Consumes: T1 types.
- Produces:
```ts
export const AGENT_REVIEW_MAX_FIX_ROUNDS = 3;
export type ReviewerOutcome =
  | { kind: "result"; result: RuntimeAgentReviewResult }
  | { kind: "timeout" } | { kind: "crashed"; error: string } | { kind: "bad_output"; error: string }
  | { kind: "modified_worktree"; paths: string[] } | { kind: "unavailable"; reason: string };
export type AgentReviewEvent =
  | { type: "turn_ended"; hasChanges: boolean; fingerprint: string }
  | { type: "reviewer_finished"; outcome: ReviewerOutcome; fingerprint: string; reviewerAgentId: RuntimeAgentId; now: number }
  | { type: "fix_send_failed" }
  | { type: "commit_finished"; ok: true; commitHash: string; prUrl: string | null } | { type: "commit_finished"; ok: false }
  | { type: "user_input" }
  | { type: "moved_by_user"; to: RuntimeBoardColumnId }
  | { type: "toggled_off" }
  | { type: "runtime_restarted"; taskSessionRunning: boolean; worktreeClean: boolean };
export type AgentReviewEffect =
  | { type: "move_card"; to: RuntimeBoardColumnId }
  | { type: "enqueue_review" } | { type: "cancel_review" }
  | { type: "send_fix"; fixPrompt: string; round: number } // service wraps it with buildFixPromptMessage (T6)
  | { type: "send_commit"; action: "commit" | "pr" }
  | { type: "complete_done" };
export function reduceAgentReview(input: {
  state: RuntimeAgentReviewState | null; columnId: RuntimeBoardColumnId;
  autoReviewEnabled: boolean; autoReviewMode: "commit" | "pr"; now: number; event: AgentReviewEvent;
}): { state: RuntimeAgentReviewState | null; effects: AgentReviewEffect[] };
```

- [ ] **Step 1: Write failing tests** (one `it` each, asserting both `state` and `effects`):
  - `turn_ended` with `hasChanges: false` → status `no_changes`, the fingerprint is stored, `round` unchanged, effects `[move_card review]` when in `in_progress`, no `enqueue_review`.
  - `turn_ended` with changes in `in_progress` → `[move_card review, enqueue_review]`, status `queued`.
  - `turn_ended` with the same fingerprint as a stored `passed` → no change, no effects (spec 4.5 "passed is stable"). The same applies to `no_changes`.
  - `turn_ended` while status is `committing` → no `enqueue_review`.
  - `turn_ended` while in `user_review` → ignored.
  - fail at round 0 → `round: 1`, `fixPrompts.length === 1`, effects `[{ type: "send_fix", fixPrompt: result.fixPrompt, round: 1 }]`, status `fixing`.
  - **Round limit:** run fail×4 in sequence → the 4th gives status `needs_user`, reason `round_limit`, `[move_card user_review]`, and exactly 3 `send_fix` effects across the sequence.
  - `cannot_verify` → `needs_user`/`cannot_verify`, no `send_fix`.
  - `pass` with `appVerified: false` → not a pass. It is treated as `cannot_verify` → `needs_user`.
  - each of timeout / crashed / bad_output / unavailable / modified_worktree → `needs_user` with the matching reason. `modified_worktree` sets `reasonDetail` to the paths joined by `\n`, and there is no `send_fix`.
  - pass + autoReview on → summary saved, status `committing`, `[send_commit(autoReviewMode)]`.
  - `commit_finished ok` → `meta.commitHash` set, `meta.rounds === round`, `[complete_done]`.
  - `commit_finished` not ok → `needs_user`/`commit_failed`, summary kept.
  - **BLOCKED ON Q1:** `it("pass with autoReview off …")`. Use exactly one of:
    - Q1-A: status `passed`, effects `[]`, the card stays in `review`.
    - Q1-B: status `committing`, effects `[send_commit("commit")]`.
    - Q1-C: status `passed`, effects `[complete_done]`.
  - `fix_send_failed` → `needs_user`/`task_agent_not_running`.
  - `user_input` → `round: 0`, `fixPrompts: []`. If status was `reviewing`/`queued` → `[cancel_review]`.
  - `moved_by_user` from `user_review` to `review` → `round: 0`, `[enqueue_review]`. To `in_progress` → `round: 0`, no effects.
  - `toggled_off` → state `null`, `[cancel_review]` if a review was running/queued.
  - `runtime_restarted`: `reviewing` → `[enqueue_review]` with the same round. `committing` + clean → `[complete_done]`, + dirty → `commit_failed`. `fixing` + session not running → `task_agent_not_running`.
- [ ] **Step 2:** `npx vitest run test/runtime/agent-review/agent-review-reducer.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement as a `switch` on `event.type`. No I/O, no `Date.now()` (use `now`).
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): pure review state reducer`

---

### Task 11: AgentReviewService (per-workspace orchestration)

**Files:**
- Create: `src/agent-review/agent-review-service.ts`
- Test: `test/runtime/agent-review/agent-review-service.test.ts`

**Interfaces:**
- Consumes: T2 mutations, T3 `buildTaskGitActionPrompt`, T4 `completeTaskToDone`, T5 git helpers, T6 prompt/parser, T7 `startReviewerRun`, T8 `classifyTurnEnd` / `sendPromptToTask`, T10 `reduceAgentReview`, `mutateWorkspaceState`, `moveTaskToColumn`.
- Produces:
```ts
export interface AgentReviewServiceDeps {
  workspaceId: string; repoPath: string;
  terminalManager: TerminalSessionManager; clineService: ClineTaskSessionService;
  loadRuntimeConfig(): Promise<RuntimeConfigState>;
  resolveTaskCwd(taskId: string, baseRef: string): Promise<string>;
  doneDeps: CompleteTaskToDoneDeps;
  broadcastStateUpdated(): Promise<void>;
  startReviewerRun?: typeof startReviewerRun; // test seam
  now?: () => number;
}
export interface AgentReviewService {
  start(): Promise<void>;               // subscribe to onSummary of both services, then run restart recovery
  notifyUserInput(taskId: string): void;
  notifyBoardChanged(): Promise<void>;  // after any browser/CLI save: detect user moves, toggles, deletions
  dispose(): Promise<void>;             // cancel the running reviewer, unsubscribe
}
export function createAgentReviewService(deps: AgentReviewServiceDeps): AgentReviewService;
```
Rules the implementer must follow:
- Every state change goes through `mutateWorkspaceState`: re-read the card, run the reducer, write `agentReview` + column move in **one** write, then `broadcastStateUpdated()`. If the card is gone or `agentReviewEnabled` is false at write time, drop the event.
- Column auto-moves for agent-review cards: session `running` while the card is in `review` → `move_card in_progress` (not when the card is in `user_review`). A turn end → reducer `turn_ended`.
- Review run: 1 at a time per service, in FIFO order. Before the run: `computeTaskReviewFingerprint` + `captureWorktreeSnapshot`. After it: snapshot again. Any diff → `modified_worktree`. Otherwise parse the output → `result` / `bad_output`. Map runner outcomes 1:1. An `AgentReviewGitError` → `crashed` with the message.
- Reviewer agent = `config.reviewerAgent === "same_as_task" ? card.agentId ?? config.selectedAgentId : config.reviewerAgent`.
- Effect `send_fix`: `sendPromptToTask(buildFixPromptMessage({ fixPrompt, round, maxRounds: AGENT_REVIEW_MAX_FIX_ROUNDS }))`. If it fails, feed the reducer `fix_send_failed`.
- Effect `send_commit`: build the prompt with `buildTaskGitActionPrompt` and send it with `sendPromptToTask`. Start a `COMMIT_STEP_TIMEOUT_MS` timer. The next `turn_end` with `hasChanges` false at the working-tree level (`git status --porcelain` empty) → `commit_finished ok` with `git rev-parse HEAD`. `prUrl` = the last `https://github.com/.+/pull/\d+` in `latestHookActivity.finalMessage`, else null. Timeout or still dirty → `commit_finished` not ok.
- Effect `complete_done`: `completeTaskToDone` with `beforeMove` writing the final `agentReview` (meta included).
- A reviewer result whose card left `review`, or whose round/fingerprint no longer matches → dropped.

- [ ] **Step 1: Write failing tests.** Use fake terminal manager and Cline service (emit summaries by hand), a fake `startReviewerRun` returning scripted outcomes, a real temp git repo + temp Kanban home, and fake `doneDeps`.
  - `it("reviews on turn end, passes, commits and completes to Done with meta saved before the worktree is deleted")`: assert the `doneDeps` call order and that the card in `trash` has `agentReview.summary` and `meta.commitHash`.
  - `it("moves in_progress → review on turn end without a browser")`
  - `it("sends a fix prompt on fail and moves the card to in_progress when the agent runs")`
  - `it("fourth failed review moves to user_review with round_limit")`
  - `it("empty diff sets no_changes and never runs the reviewer")`
  - `it("permission request does not start a review")`
  - `it("runs at most one reviewer at a time in a workspace")`: two cards end turns together. The second run starts only after the first resolves.
  - `it("reviewer that edits a tracked file sends the task to user_review with the path")`
  - `it("drops reviewer result when the card left review mid-run")`: during the run, move the card to `trash` (and in a second case, delete it). Assert `cancel` was called and the board has no `agentReview` write for it. (Review Focus 3)
  - `it("user input during a review cancels it and resets the round")`
  - `it("toggle off during a review cancels it and clears state")`
  - `it("diff failure goes to user_review instead of crashing the loop")`: `baseRef` = a missing branch. Then a second card in the same workspace is still reviewed. (Review Focus 5)
  - `it("commit step timeout → commit_failed")` (fake timers)
  - `it("restart recovery re-runs a review that was reviewing, same round")`
  - `it("tasks without agentReviewEnabled are never touched")`
- [ ] **Step 2:** `npx vitest run test/runtime/agent-review/agent-review-service.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command, then `npm run typecheck && npm run test:fast`. Expected: PASS, and the run exits on its own (no live child processes; see `.plan/docs/node22-ci-hanging-tests-investigation.md`).
- [ ] **Step 5: Commit**: `feat(agent-review): per-workspace agent review service`

---

### Task 12: Runtime wiring, startup scan, and integration test

**Files:**
- Modify: `src/server/runtime-server.ts` (create one service per workspace next to `getScopedClineTaskSessionService`, build `doneDeps` from the in-process runtime/workspace APIs: stop session, `startTaskSession` for dependents, `deleteTaskWorktree`, `broadcastRuntimeWorkspaceStateUpdated` + `broadcastRuntimeProjectsUpdated`)
- Modify: `src/cli.ts` (~line 410–445: startup scan), `src/trpc/workspace-api.ts` (`saveState` / `notifyStateUpdated` → `service.notifyBoardChanged()`), dispose paths (`disposeTrackedWorkspace`, `prepareForStateReset`)
- Test: `test/integration/agent-review.integration.test.ts`

**Interfaces:**
- Consumes: T11 `createAgentReviewService`, T8 `onTaskUserInput` deps.
- Produces: `ensureAgentReviewServiceForWorkspace(workspaceId: string, repoPath: string): Promise<AgentReviewService>` inside runtime-server. A startup function `startAgentReviewForRegisteredWorkspaces()` that goes over `listWorkspaceIndexEntries()` and, for each board with an `agentReviewEnabled` card in `in_progress | review`, calls `ensureTerminalManagerForWorkspace` + the Cline service + `ensureAgentReviewServiceForWorkspace`.

- [ ] **Step 1: Write failing integration tests** (temp home, real git repo, fake reviewer via the `startReviewerRun` seam, fake task session summaries):
  - `it("starts agent review for a non-active registered workspace at runtime startup")`
  - `it("a browser save with an old revision gets a conflict and does not overwrite the runtime's agentReview write")`: spec 5.1 asks for this check.
  - `it("removing a project disposes its agent review service and kills a running reviewer")`
  - `it("CLI task trash from user_review starts dependents")` (uses T4 through the real CLI path)
- [ ] **Step 2:** `npx vitest run test/integration/agent-review.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the wiring.
- [ ] **Step 4:** Same command, then `npm run check`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(agent-review): wire agent review service into the runtime`

---

### Task 13: web-ui columns, card types, and browser hands-off

**Files:**
- Modify: `web-ui/src/types/board.ts` (`BoardCard` + `agentReviewEnabled?`, `agentReview?: RuntimeAgentReviewState`)
- Modify: `web-ui/src/state/board-state.ts` (`normalizeColumnId`, `normalizeCard`)
- Modify: `web-ui/src/data/board-data.ts`, `state/drag-rules.ts`, `components/ui/column-indicator.tsx`, `utils/detail-view-task-order.ts`, `components/dependencies/dependency-overlay.tsx`, `components/project-navigation-panel.tsx`, `components/kanban-board.tsx`, `components/board-card.tsx`, `components/card-detail-view.tsx`. Also grep `"review"` / `"trash"` under `web-ui/src` and add `user_review` wherever columns are listed.
- Modify: `web-ui/src/hooks/use-board-interactions.ts` (no auto-moves out of `user_review`), `web-ui/src/hooks/use-review-auto-actions.ts` (skip `agentReviewEnabled` cards)
- Test: `web-ui/src/state/board-state.test.ts` (create it if missing), `web-ui/src/hooks/use-review-auto-actions.test.tsx`, `web-ui/src/hooks/use-board-interactions.test.tsx`, `web-ui/src/state/drag-rules.test.ts` (or the existing drag-rules test)

**Interfaces:**
- Consumes: T1 types via `@/runtime/types`.
- Produces: a `BoardCard` that keeps the agent-review fields, and a `user_review` column titled "Needs your review" between Review and Done.

- [ ] **Step 1: Write failing tests**
  - `it("normalizeBoardData keeps agentReviewEnabled and agentReview")`: round-trip a card with full `agentReview` state, then `toEqual`. (Review Focus 1)
  - `it("normalizeBoardData adds an empty user_review column to an old 4-column board")`
  - `it("does not auto-commit a card with agentReviewEnabled")`: a Review card with `autoReviewEnabled` + `agentReviewEnabled` + changed files → `runAutoReviewGitAction` is not called after 500 ms.
  - `it("still auto-commits a card without agentReviewEnabled")` (regression)
  - `it("does not move a user_review card to in_progress when its session runs")`
  - `it("allows dragging user_review → review, in_progress and trash")`
- [ ] **Step 2:** `npm run web:test -- board-state use-review-auto-actions use-board-interactions drag-rules`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run web:typecheck && npm run web:test`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(web-ui): Needs your review column and agent-review card fields`

---

### Task 14: web-ui toggle, reviewer setting, and status display

**Files:**
- Modify: `web-ui/src/components/task-create-dialog.tsx`, `task-inline-create-card.tsx`, `hooks/use-task-editor.ts` (an "Agent review" toggle next to auto-review, default off)
- Modify: `web-ui/src/components/runtime-settings-dialog.tsx` (Radix Select "Reviewer agent": "Same as task" + launch-supported agents)
- Create: `web-ui/src/components/agent-review-status-badge.tsx`, `web-ui/src/components/agent-review-result-panel.tsx`
- Modify: `components/board-card.tsx` (badge), `components/card-detail-view.tsx` (result panel)
- Test: next to each component: `agent-review-status-badge.test.tsx`, `agent-review-result-panel.test.tsx`, extend `runtime-settings-dialog.test.tsx` and `use-task-editor.test.tsx`

**Interfaces:**
- Consumes: T13 `BoardCard`, T1 types, the T1 config field `reviewerAgent`.
- Produces: `AgentReviewStatusBadge({ state }: { state: RuntimeAgentReviewState | undefined })`, `AgentReviewResultPanel({ state }: { state: RuntimeAgentReviewState })`, and `getAgentReviewBadgeLabel(state: RuntimeAgentReviewState): string`.

Badge copy (exact): `queued` → "Review queued"; `reviewing` → "Reviewing {round+1}/{4}"; `fixing` → "Fixing {round}/3"; `committing` → "Committing"; `passed` → "Agent review passed"; `no_changes` → "No changes, not reviewed"; `needs_user` → the reason label. Reason labels: `round_limit` "3 fix rounds used", `cannot_verify` "Reviewer could not verify", `reviewer_crashed` "Reviewer crashed", `reviewer_timeout` "Reviewer timed out", `reviewer_bad_output` "Reviewer gave no valid result", `reviewer_modified_worktree` "Reviewer modified the worktree", `reviewer_agent_unavailable` "Reviewer agent not available", `task_agent_not_running` "Task agent not running", `commit_failed` "Commit failed".

Result panel: the 5 summary fields under the headings "What was done", "What it affects", "Against the request", "How it was verified", "Risks / check by hand", then Meta (commit hash, rounds, reviewer agent, review time). For `needs_user`: verdict, reason + `reasonDetail`, and the last fix prompt. Collapsed by default on the Done card, expanded in the detail view. Use tokens from AGENTS.md (`bg-surface-2`, `text-text-secondary`, `status-*`) and Lucide icons at 14px.

- [ ] **Step 1: Write failing tests**
  - `it.each` over every status/reason → `getAgentReviewBadgeLabel` returns the exact copy above (`"Reviewing 2/4"` for `{status:"reviewing", round:1}`).
  - `it("renders the five summary headings and the commit hash")`
  - `it("shows reason detail paths for reviewer_modified_worktree")`
  - `it("new task defaults agentReviewEnabled to false and saves true when toggled")`
  - `it("settings dialog saves reviewerAgent")`
- [ ] **Step 2:** `npm run web:test -- agent-review runtime-settings-dialog use-task-editor`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm run web:typecheck && npm run web:test && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(web-ui): agent review toggle, reviewer setting and status display`

---

## Final check (after T12 and T14 merge)

- [ ] `npm run check && npm run web:typecheck && npm run web:test`: all pass.
- [ ] Manual smoke test (the `run` skill or `npm run dev:full`): create a task with Agent review on and auto-commit on, close every browser tab, and wait. The card ends in Done with a summary, or in Needs your review with a reason. Reopen the browser and confirm the board matches `board.json`.
- [ ] Propose an AGENTS.md note: "Agent-review cards are owned by the runtime `AgentReviewService`. The browser must not auto-commit or auto-move them."
