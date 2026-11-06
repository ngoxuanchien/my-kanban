# Employee Profiles Implementation Plan

> **For agentic workers:** Each task below is one Kanban task, run by a Codex/OpenCode/Antigravity agent in its own worktree. Steps use checkbox (`- [ ]`) syntax. Do not commit; the sidebar reviewer commits on pass.

**Goal:** Every agent + model pair becomes an employee with a profile (score, derived areas, declared tags, status); `employee rank` picks the employee for new tasks and for handoff.

**Architecture:** A pure area mapper and a pure ranker in `src/core/`; a state module in `src/state/` that joins existing `agent-scores.json` events, task-history `pass` commits (files via `git diff-tree`), and a new declared `employees.json`. The CLI, the handoff path, and a web-ui popover all read through that state module.

**Tech Stack:** TypeScript, commander (CLI), zod (contract), tRPC, React + Tailwind v4 + Radix popover, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-employee-profiles-design.md`

## Global Constraints

- Employee key = `resolveScoreAgentKey` output (`src/core/claude-model.ts:18`): `codex:<model>`, `opencode:<model>`, plain `codex`/`opencode` (default model), `opus`/`sonnet`/`haiku` (agent `claude`), plain `antigravity`. No migration of existing events.
- Areas, in this order, first match per file: `web-ui` (`web-ui/`), `desktop` (`packages/desktop/`), `issue-sync` (path contains `github-issue` or `issue-sync`), `terminal` (`src/terminal/`), `cli` (`src/commands/`, `src/cli.ts`), `state` (`src/state/`, `src/fs/`), `server` (`src/server/`, `src/trpc/`), `cline-sdk` (`src/cline-sdk/`), `runtime-other` (other `src/`), `docs` (`docs/`, `*.md`), `tests` (`test/`). `tests` counts only when the task matched no other area.
- Out of quota: an agent is out of quota when any board card with that `agentId` has `quotaBlockedAt` and `now - quotaBlockedAt < 3600000`.
- `employees.json` lives next to `agent-scores.json` (`getWorkspaceDirectoryPath(workspaceId)`), written with `lockedFileSystem`, shape `{ version: 1, employees: { [key]: { status: "active"|"inactive", strong: string[], avoid: string[], notes: string } } }`; unknown keys preserved on write.
- No change to `~/.claude`, `~/.codex`, `~/.config/opencode`.
- Tests that spawn git pass `env: createGitTestEnv()` (`test/utilities/git-env.ts`).
- Acceptance for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck`, `npm --prefix web-ui run test`, `npm run web:build`.

## Review Focus

1. Malformed or missing `employees.json` → profiles load with defaults (active, no tags) and a warning, never a crash. Test in Task 1.
2. A `pass` event whose commit no longer exists in the repo (rebased away) → that task's areas are unknown; score still counts. Test in Task 1.
3. `employee set --strong` with an unknown area → CLI exits non-zero with the list of valid areas; file unchanged. Test in Task 2.
4. Handoff when every agent is ineligible → hands off to the plain next agent as today, no throw. Test in Task 3.
5. Handoff after a skip → the prompt's previous-agent list shows the agents that really ran (from history), not the plain cycle. Test in Task 3.

---

### Task 1: Areas, profiles, ranking (core + state)

**Files:**
- Create: `src/core/employee-areas.ts`, `src/core/employee-rank.ts`, `src/state/employees.ts`
- Modify: `src/state/agent-scores.ts` (export an event loader)
- Test: `test/runtime/core/employee-areas.test.ts`, `test/runtime/core/employee-rank.test.ts`, `test/runtime/state/employees.test.ts`

**Interfaces (produces):**
- `employee-areas.ts`: `EMPLOYEE_AREAS` (readonly tuple, order above), `type EmployeeArea`, `isEmployeeArea(v: string): v is EmployeeArea`, `areasOfFiles(paths: string[]): EmployeeArea[]` (deduped, `tests` only when nothing else).
- `agent-scores.ts`: `loadAgentScoreEvents(workspaceId: string): Promise<AgentScoreEvent[]>` (wraps the private reader; `loadAgentScores` uses it).
- `employees.ts`:
  - `parseEmployeeKey(key: string): { agentId: string; model: string | null }` (`opus` → `{claude, "opus"}`, `codex` → `{codex, null}`, `codex:gpt-5` → `{codex, "gpt-5"}`).
  - `interface DeclaredEmployee { status: "active" | "inactive"; strong: EmployeeArea[]; avoid: EmployeeArea[]; notes: string }`
  - `loadDeclaredEmployees(workspaceId): Promise<Record<string, DeclaredEmployee>>`
  - `updateDeclaredEmployee(workspaceId, key, patch: Partial<DeclaredEmployee>): Promise<DeclaredEmployee>`
  - `interface EmployeeProfile { key; agentId; model: string | null; status; strong; avoid; notes; score: RuntimeAgentScore; areas: Partial<Record<EmployeeArea, { passes: number; fails: number }>> }`
  - `loadEmployeeProfiles(input: { workspaceId: string; repoPath: string }): Promise<EmployeeProfile[]>` — task areas from the task-history `pass` event's `commit` via `git diff-tree --no-commit-id -r --name-only <commit>` in `repoPath`; cache per task id in memory for the process. A task's fail events count against that task's areas.
- `employee-rank.ts`:
  - `outOfQuotaAgentIds(board: RuntimeBoardData, now: number): Set<string>`
  - `interface RankedEmployee { key; agentId; model: string | null; reason: string }`
  - `rankEmployees(input: { profiles: EmployeeProfile[]; areas: EmployeeArea[]; difficulty: number; outOfQuota: Set<string>; agentIds?: string[] }): RankedEmployee[]` — filter: active, agent not out of quota, no `avoid` tag in `areas`, `agentIds` filter if given. Sort: strong tag hit desc; Laplace area rate `(p+1)/(p+f+2)` summed over requested areas, compared rounded to 0.05, desc; then for `difficulty >= 4` overall `passes` desc, else overall `score` desc; then key asc. `reason` is ≤ 6 words, e.g. `strong web-ui`, `web-ui 7/1`, `score 4`.

- [ ] **Step 1:** Write `employee-areas.test.ts`: `areasOfFiles(["web-ui/src/a.tsx","test/x.test.ts"])` → `["web-ui"]`; `areasOfFiles(["test/x.test.ts"])` → `["tests"]`; `src/server/github-issue-sync.ts` → `issue-sync`; `src/cli.ts` → `cli`; `README.md` → `docs`.
- [ ] **Step 2:** Write `employee-rank.test.ts`: 9/1 beats 1/0 on the area; strong tag beats better rate; avoid excludes; inactive excludes; out-of-quota agent excludes (card `quotaBlockedAt = now - 1000`) but `now - 3600001` does not; `agentIds: ["opencode"]` filters; empty profiles → `[]`.
- [ ] **Step 3:** Write `employees.test.ts` (temp runtime home as other state tests do): `parseEmployeeKey` cases; malformed `employees.json` → `{}` + warn; `updateDeclaredEmployee` keeps an unknown top-level key; `loadEmployeeProfiles` with a temp git repo (`createGitTestEnv()`): one task passed with a commit touching `web-ui/` and one fail round → `areas["web-ui"]` = `{passes:1, fails:1}`; a `pass` with a missing commit → no areas, score still counts.
- [ ] **Step 4:** Run `npx vitest run test/runtime/core/employee-areas.test.ts test/runtime/core/employee-rank.test.ts test/runtime/state/employees.test.ts` — expect FAIL (modules missing).
- [ ] **Step 5:** Implement the three modules and the `agent-scores.ts` export.
- [ ] **Step 6:** Re-run the three tests — PASS. Run the full acceptance list.

### Task 2: `employee` CLI and sidebar prompt

**Files:**
- Create: `src/commands/employee.ts`
- Modify: `src/cli.ts:658` (register next to `registerTaskCommand`), `src/prompts/append-system-prompt.ts:379` and `:381-393`
- Test: `test/runtime/employee-command.test.ts`, `test/runtime/append-system-prompt.test.ts`

**Interfaces:** Consumes everything Task 1 produces. Produces `registerEmployeeCommand(program: Command): void`.

Commands (all take `--project-path`, resolve the workspace like `task` commands in `src/commands/task.ts`):
- `employee list` — one line per profile: `<key>  <status>  s<score> <passes>/<fails>  <top 3 areas as area p/f>  +strong -avoid`.
- `employee show --employee <key>` — JSON of the `EmployeeProfile`.
- `employee set --employee <key> [--status active|inactive] [--strong a,b] [--avoid a,b] [--notes "<text>"]` — invalid area or status → stderr names the valid values, exit code 1, no write.
- `employee rank (--area a,b | --files f1,f2) --difficulty <1-5>` — ≤ 5 lines: `<key>  <reason>  --agent-id <agentId>[ --model <model>]`; no `--model` when `model` is null; Claude prints `--agent-id claude --model opus` etc. No result → prints `no data: use the rotation rule` and exits 0.

Prompt change in `append-system-prompt.ts`: add an "employee" CLI reference section like the `task` ones; replace the rotation rule at line 379 with: when the user names no agent/model, run `employee rank --files <the prompt's Files you may change> --difficulty <n>` and pass the top line's `--agent-id`/`--model`; if it prints `no data`, use the existing rotation rule (keep its text). Change line 392 to "Pass --model/--reasoning-effort only when the user names a model or `employee rank` suggests one."

- [ ] **Step 1:** Write `employee-command.test.ts`: `set --strong web-ui` then `list` shows `+web-ui`; `set --strong bogus` exits 1, file unchanged; `rank --area web-ui --difficulty 2` with seeded events prints a first line ending `--agent-id codex --model gpt-5`; `rank` with no data prints `no data`.
- [ ] **Step 2:** Extend `append-system-prompt.test.ts`: prompt contains `employee rank` and still contains the rotation rule text.
- [ ] **Step 3:** Run both tests — FAIL.
- [ ] **Step 4:** Implement; register in `src/cli.ts`.
- [ ] **Step 5:** Tests PASS; full acceptance list.

### Task 3: Handoff picks an employee; fix handoff fail score key

**Files:**
- Modify: `src/server/hand-off-task.ts:61-140`, `src/core/hand-off-cap.ts`, `src/trpc/app-router.ts:600-612`
- Test: hand-off tests under `test/runtime/server/` (extend the existing one), `test/runtime/agent-score-recording.test.ts`

**Interfaces:** Consumes `loadEmployeeProfiles`, `rankEmployees`, `outOfQuotaAgentIds`, `areasOfFiles` (Task 1). Produces in `hand-off-cap.ts`: `nextEligibleHandOffAgent(from: HandOffAgentId, eligible: (agentId: HandOffAgentId) => boolean): HandOffAgentId` — walks `HAND_OFF_CYCLE` after `from` (excluding `from`), returns the first eligible, else `nextHandOffAgent(from)`.

Behavior:
- Before the mutation, compute task areas from the task worktree: `git diff --name-only <card.baseRef>` + `git ls-files --others --exclude-standard`. Failure → areas `[]`.
- Rank once with `agentIds: [...HAND_OFF_CYCLE]`; an agent is eligible if it has a ranked employee, or if it has no profiles at all (no data keeps old behavior). `toAgentId = nextEligibleHandOffAgent(...)`.
- In the card rebuild, still drop the old `agentModel`/`agentReasoningEffort`, then set `agentModel` to the top ranked employee's model for `toAgentId` when non-null (codex/opencode only).
- `previousAgentIds` for `buildHandOffPrompt`: built from task-history `handoff` events (`agentId` chain) plus `fromAgentId`, falling back to `handOffHistory(...)` when history has none.
- `app-router.ts`: read the task's session summary model before calling `handOffTask` and pass `sessionAgentModel` to `resolveScoreAgentKey`, so the fail lands on `codex:<model>`.

- [ ] **Step 1:** Tests: `nextEligibleHandOffAgent("codex", a => a === "antigravity")` → `antigravity`; none eligible → `opencode`. Handoff with all opencode employees `inactive` goes codex → antigravity. Handoff with ranked `opencode:m1` sets card `agentModel = "m1"`. Prompt previous agents after a skip list the agents that really ran. All agents ineligible → plain next agent, `ok: true`. Handoff fail with session model `gpt-5` records `codex:gpt-5`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; full acceptance list.

### Task 4: Employee popover on the score bar

**Files:**
- Modify: `src/core/api-contract.ts` (add `runtimeEmployeeProfileSchema` matching `EmployeeProfile`), `src/trpc/workspace-api.ts` + router registration in `src/trpc/app-router.ts` (query `getEmployeeProfile({ key }) → RuntimeEmployeeProfile | null`), `web-ui/src/components/agent-score-bar.tsx`, and the caller that renders it (check `App.tsx` wiring)
- Test: a `test/runtime/trpc/` test for the query, `web-ui/src/components/agent-score-bar.test.tsx`

**Interfaces:** Consumes `loadEmployeeProfiles` (Task 1). Profiles are fetched only when a popover opens; they are not added to the workspace state broadcast (that would run `git diff-tree` on every state load).

UI: each score entry becomes a Radix popover trigger (`@radix-ui/react-popover`, tokens `bg-surface-1`, `border-border`, `text-text-secondary`). Content: status, top 3 areas `area p/f`, `+strong`, `-avoid`, notes (2-line clamp), and the hint `Edit: kanban employee set --employee <key>`. Loading → `Spinner size={14}`; null → "No profile data". Read-only.

- [ ] **Step 1:** Tests: query returns a profile for a seeded key and `null` for an unknown key; component test opens the popover and shows `web-ui 1/0` and `+web-ui`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement, including the real wiring from `App.tsx` (not only the component).
- [ ] **Step 4:** PASS; full acceptance list.

## Task order

Task 1 first. Tasks 2, 3, 4 depend only on Task 1 and can run in parallel.
