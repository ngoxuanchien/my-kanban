# Compact `task list` and task comments as shared memory

Idea source: emanuele-em/kanzo (MCP replies of 10-60 tokens; agents comment on tasks).

## Why
- Token cost: the sidebar runs `task list` all the time. Each task carries its full prompt, worktree path, settings and session (`formatTaskRecord`, `src/commands/task.ts:450`); one task is ~3 KB, 70% of it the prompt.
- Lost context: after a handoff or `task start --message`, the next agent only sees the diff. The previous agent's decisions and progress are gone.

## Part 1: compact `task list` + `task show`

### `task list` default output: plain text, one line per task
```
e1329  review       codex  r2/9 h2  idle     Show saved task patch in Done history
fb2b0  in_progress  codex  r1/6 h1  running  Abbreviate long project paths fish-style
61185  done         codex  r1/6 h1  -        Restart a stopped Review task with task start
(11 more done not shown; pass --column done or --all)
links: efdb4 waits on 2978e (dep 31293cde)
last created: 7bb9b (opencode)
```
- Columns: id, column, agentId (or `-`), `r<reviewRound>/<cap>` where cap = 3 × (handOffCount + 1) only when agent review is on (else `-`), `h<handOffCount>`, session state (or `-`), title (fallback: first line of prompt, truncated to ~80 chars).
- Done: show only the **3 most recent Done tasks** (top of the Done column), then `(n more done not shown; …)`. `--column done` or `--all` shows all.
- Trash stays hidden (as today).
- `links:` line(s) list dependencies with their id (needed for `task unlink`); omit when none.
- `last created:` the most recently created task and its agent (the sidebar's agent rotation needs it).
- `--json`: the same rows as compact JSON (`{ ok, tasks: [{ id, column, agentId, reviewRound, handOffCount, session, title }], doneHidden, dependencies, lastCreated }`).
- `--full`: today's exact JSON output (backward compatible for scripts).
- Errors stay JSON (`{ ok: false, error }`) so callers can always detect them.

### `task show --task-id <id>`
Full JSON for one task: today's `formatTaskRecord` fields (prompt, worktreePath, baseRef, session, settings, reviewRound, handOffCount, …) plus `comments` (Part 2).

### Sidebar instructions (`src/prompts/append-system-prompt.ts`)
- `task list` section: describe the text format, `--column`, `--all`, `--json`, `--full`.
- Add a `task show` section.
- Review step 1: read the task's prompt with `task show`, not `task list`.
- Keep everything else unchanged.

## Part 2: task comments

### Storage
A new task-history event type `comment` in `task-history/<taskId>.json` (`src/state/task-history.ts`): `{ type: "comment", agentId, at, detail: <body> }`. No new board-card field (see `AGENTS.md`: card fields must be threaded through many rebuild sites). Reuse the existing `detail` truncation; cap a body at 2,000 chars.

### `task comment --message "<text>" [--task-id <id>] [--project-path <path>]`
- `--task-id` defaults to `KANBAN_HOOK_TASK_ID` (set in every task session, `src/terminal/hook-runtime-context.ts`); error if neither is given.
- `agentId` = the task's current agent (`user` when run outside a task session without one).
- Returns `{ ok: true, taskId }`.

### Reading comments
- `task show` includes `comments: [{ agentId, at, body }]`, oldest first.
- Handoff prompt (`buildHandOffPrompt`, `src/server/hand-off-task.ts`) and restart prompt (`buildRestartPrompt`, `src/commands/task.ts`) append the most recent comments, newest last, up to ~3,000 chars total: `Notes from earlier agents:\n- <agentId>, <time>: <body>`. Omit the block when there are none.
- Done history timeline (`web-ui/src/components/done-task-detail-view.tsx`, `getEventDisplayInfo`) shows `comment` events with a "Comment" label and the body as detail.

### Telling agents to comment
When the runtime starts a task session (`startTaskSession` in `src/trpc/runtime-api.ts`), append a short footer to the prompt sent to the agent (not to the stored card prompt):
```
---
[Kanban notes] Record key decisions, progress, and blockers for the next agent with:
<kanban command> task comment --message "<1-3 lines>"
Comment when you make a non-obvious decision and before you stop with work unfinished. Keep it short; never paste diffs or secrets.
```
Use the same command prefix resolution as the sidebar prompt (`resolveAppendSystemPromptCommandPrefix`). Do not add the footer twice (handoff/restart prompts already built from the card prompt plus this footer once).

## Non-goals
- MCP server, comments from the web UI, editing/deleting comments, a Human flag.

## Tests
- Part 1: text output for a mixed board (column/round/handoff/session columns, Done trimmed to 3 + count line, links line, last created); `--all`; `--column done`; `--json` shape; `--full` equals the old output; `task show` fields; sidebar prompt mentions `task show`.
- Part 2: `task comment` with `--task-id` and with `KANBAN_HOOK_TASK_ID`; error without either; comments appear in `task show`; handoff and restart prompts include recent comments within the cap; footer appended once on session start; timeline renders a comment event.
