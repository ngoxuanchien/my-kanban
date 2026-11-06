# Employee profiles

Part 1 of 3 of the "agents as a company" upgrade:

1. **Employee profiles** (this spec): each agent + model pair is an employee with a score, derived skills, and declared skills. The sidebar picks the employee for each task from the profiles.
2. Per-employee skill set (later spec): each employee loads only the skills/MCP servers in its profile.
3. Manager finds work (later spec): the runtime wakes the sidebar on a schedule; it scans upstream issues and app error traces, creates and starts tasks within limits, and writes a report to `report/`. Decided already for part 3: only issues written by the owner's own GitHub account may start automatically; a task from anyone else's issue is created in backlog and waits for the owner's approval, because issue text from strangers can carry prompt injection into agents that run without permission prompts.

Parts 2 and 3 build on the profile defined here. They are out of scope for this spec.

## Intent

Today the sidebar picks an agent by rotation (codex → opencode → antigravity) and the model comes from the difficulty table. Neither uses what we already know: which agent + model passed or failed which kind of work. The owner wants the sidebar to act like a manager who knows each employee's track record and strengths, and gives each task to the employee most likely to pass review the first time. Fewer failed rounds and handoffs mean fewer tokens.

## Goals

- An **employee** is one score key as `resolveScoreAgentKey` (`src/core/claude-model.ts:18`) produces it today: `codex:<model>`, `opencode:<model>`, `opus`/`sonnet`/`haiku` for Claude, and plain `antigravity` (Antigravity has no per-task model, so it is one employee). Plain `codex` / `opencode` (no model resolved, for example an empty difficulty table) are their own employee, "default model"; existing events keep their keys, no migration. For employees without a model, `employee rank` prints `--agent-id` only, no `--model`.
- Each employee has a **profile**:
  - **Score**: passes, fails, tasks, score (pass − fail), exactly as `summarizeAgentScoreEvents` computes today.
  - **Derived skills**: per work area, how many tasks the employee passed and failed. Computed by the runtime from score events and the areas of each task (see "Work areas").
  - **Declared skills**: free-form notes and area tags the owner writes by hand, for example "strong at web-ui", "avoid concurrency".
  - **Status**: `active` or `inactive`. An inactive employee is never picked.
- A ranked suggestion: given an area (or a list of files) and a difficulty, the runtime returns employees ranked by fit. The sidebar uses the top one when it creates a task.
- The owner can read and edit profiles from the CLI. The sidebar reads them through the CLI.

## Non-goals

- Per-employee skill/MCP sets (part 2).
- Autonomous work discovery and reports (part 3).
- Changing how review, rounds, or the handoff cap work.
- A full web UI for profiles. See "UI" for the small part that is in scope.

## Anti-goals

- The sidebar spends many tokens reading profiles. The CLI output for ranking must be a few compact lines, not full profiles.
- Ranking that ignores the owner. Declared skills and `inactive` always win over derived data.
- A new score store that drifts from `agent-scores.json`. Profiles read the existing events; they do not copy them.

## Work areas

A task's areas are derived from the files it changed, using fixed path-prefix rules in code (first match wins per file):

| Area | Path prefixes |
|---|---|
| `web-ui` | `web-ui/` |
| `desktop` | `packages/desktop/` |
| `terminal` | `src/terminal/` |
| `cli` | `src/commands/`, `src/cli.ts` |
| `state` | `src/state/`, `src/fs/` |
| `server` | `src/server/`, `src/trpc/` |
| `issue-sync` | files whose path contains `github-issue` or `issue-sync` |
| `cline-sdk` | `src/cline-sdk/` |
| `runtime-other` | any other `src/` file |
| `tests` | `test/`, counted only when the whole task matched no other area (decided per task, not per file) |
| `docs` | `docs/`, `*.md` |

The files come from the task's recorded commit on the base branch when it passed review. When a task has no recorded commit (trashed or not yet done), its areas are unknown and its events count only toward the plain score, not toward areas. Fail events count against the areas of the task they belong to, once that task's areas are known (the task usually passes later, perhaps with another employee).

Areas are computed when needed and may be cached per task id; the builder decides whether to cache.

## Ranking

Input: one or more areas (or files, mapped to areas) and a difficulty 1–5.
Output: active employees sorted by:

1. Declared avoid-tags for any requested area: excluded.
2. Declared strong-tags for a requested area: ranked first.
3. Area pass rate for the requested areas, `passes / (passes + fails)`, with a small prior so an employee with 1/1 does not beat one with 9/10 (for example Laplace `(p+1)/(p+f+2)`; builder's call).
4. Overall score.
5. Fallback when no employee has data: the current behavior (rotation agent + difficulty table model).

Employees whose agent is currently out of quota are skipped. There is no per-agent quota record today: `quotaBlockedAt` is a card field (`src/server/sidebar-review-service.ts`). Decision (spec author's call): read-only check, an agent counts as out of quota when any card whose current agent is that agent has `quotaBlockedAt` within the last hour. Known limit: a quota hit that ended in a handoff moves the card to another agent and is not seen. No new store.

Difficulty still matters: the difficulty table stays as the fallback, and the ranking may prefer stronger models for difficulty 4–5 when pass rates are close. The exact tie-break is the builder's call; it must be documented in the code and the CLI help.

## Where profiles live

- Score and derived skills: computed from the existing per-workspace `agent-scores.json` and task records. No new store.
- Declared skills and status: a new per-workspace file next to `agent-scores.json`, for example `employees.json`, holding `{ version, employees: { [employeeKey]: { status, strong: string[], avoid: string[], notes } } }`. Written with `lockedFileSystem` like the other state files. Unknown keys are kept on write.
- An employee exists in the roster if it has any score event or a declared entry.

## CLI

New `employee` command group (exact names are the builder's call, keep them short):

- `employee list`: one compact line per employee: key, status, score, passes/fails, top 3 areas with pass/fail counts, declared tags.
- `employee show --employee <key>`: full profile including notes and every area.
- `employee set --employee <key> [--status active|inactive] [--strong a,b] [--avoid a,b] [--notes "<text>"]`: edit the declared part. Area names are checked against the area list.
- `employee rank (--area <a,b> | --files <f1,f2>) --difficulty <1-5>`: at most 5 lines, best first, each with the key, the reason in a few words, and the `--agent-id`/`--model` to pass to `task create`.

All commands take `--project-path` like `task` commands.

## Task assignment and handoff

- The sidebar system prompt (the "Workflow Notes" rule that rotates codex/opencode/antigravity and the "Task difficulty" rules) changes: when the user does not name an agent or model, the sidebar runs `employee rank` with the task's expected files (from the prompt's "Files you may change") and difficulty, and passes the top employee's `--agent-id` and `--model` to `task create`. When `employee rank` returns no data, the old rotation rule applies.
- The rule "Pass --model only when the user names a model" becomes "only when the user names a model, or `employee rank` suggests one".
- Handoff keeps the order of `HAND_OFF_CYCLE` in `src/core/hand-off-cap.ts`. Decision (spec author's call): it skips an agent that has no eligible employee (all inactive, avoid-tagged for the task's areas, or out of quota) and goes to the next one in the cycle; if no agent is eligible, it hands off to the plain next agent as today. For codex/opencode the model is the best-ranked eligible employee of that agent for the task's areas, written to `card.agentModel` so a restart keeps it; with no data the model is left unset and the difficulty table applies as today. Handoff count and cap do not change. The task's areas at handoff time come from the worktree diff against the base ref (the task has no commit yet).
- Fix the remaining score-key gap: the handoff fail event at `src/trpc/app-router.ts:608` calls `resolveScoreAgentKey({ agentId: result.fromAgentId })` without the session model, so it lands on plain `codex`/`opencode`. Pass the stopped session's model (read the session summary before the handoff replaces it). Pass/fail in `src/commands/task.ts` already passes `sessionAgentModel`; the note in `contexte/difficulty-model-selection.md` saying otherwise is stale and should be corrected.

## UI

In scope: the existing agent score bottom bar shows employees (it already lists score keys). Clicking an entry opens a small read-only popover with the employee's status, top areas, and declared tags. Editing stays in the CLI.

## Constraints

- No change to global agent config (`~/.claude`, `~/.codex`, `~/.config/opencode`).
- New card or state fields follow the threading rule in `AGENTS.md` (every card rebuild in `web-ui/src/state/board-state.ts`).
- Tests that spawn git use `createGitTestEnv()`.

## Left to the builder

- Exact CLI names and output layout, within the compactness rule.
- Area cache, prior formula, and the difficulty tie-break.
- How to read a task's recorded commit and its files (task history / Done history code already reads it).
