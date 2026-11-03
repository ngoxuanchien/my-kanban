# Restart a stopped Review task with `task start`

## Why
Task e1329 got stuck: it was in Review with no running session (its OpenCode session ended on a usage limit) and it had already been handed off twice. Every CLI path was closed:
- `task start` refuses Review (`src/commands/task.ts:858`).
- `task send` needs a running session (`src/trpc/runtime-api.ts:560`).
- `task handoff` refuses after two handoffs (`src/server/hand-off-task.ts:53`).
The sidebar reviewer (and the user) need one command to relaunch such a task on its current agent with the reviewer's fix list.

## Goal
`task start` also accepts a task in **Review** when its session is **not running**, relaunches it with the task's current `agentId` on the existing worktree, and moves it to In Progress. An optional `--message` carries the reviewer's fix list.

## Behavior
- Backlog / In Progress: unchanged. `--message` is accepted there too and appended the same way (see below) only when a new session is started.
- Review, session not running (no session, or state other than `running`): ensure worktree, start the session with the restart prompt, move to `in_progress`.
- Review, session running: error `Task "<id>" is in review with a running session; use task send instead.`
- Done / trash: unchanged error.
- Restart prompt (Review only, or whenever `--message` is given): the original prompt, then
  `---\n[Kanban restart] Earlier work on this task is already in this worktree (uncommitted changes and commits since <baseRef>). Check it and continue from it; do not start over.` and, when `--message` is set, `\nReviewer notes:\n<message>`. Model it on `buildHandOffPrompt()` in `src/server/hand-off-task.ts`.
- Does not change `handOffCount`, `reviewRound`, agent scores, or `agentId`. The runtime already records a `started` history event when a session starts.

## Sidebar instructions
Update the CLI reference and review steps in `src/prompts/append-system-prompt.ts`:
- `task start` section: document Review support and `--message`.
- Review step 3: if `task send` fails because the session is not running, run `task start --task-id <id> --message "<the same fix list>"` instead.
- Review step 4: when handoff is refused or `handOffCount` is 2 and the session is not running, `task start --message` relaunches it on the current agent (the user can change the agent first with `task update --agent-id`).
Keep the rest of the prompt unchanged; update any snapshot/string tests of this prompt.

## Non-goals
- Dragging cards in the UI, raising the handoff limit, a new `task restart` command.

## Tests
- `task start` from Review with a stopped session starts a session with the restart prompt (including `--message`) and moves the task to In Progress; `handOffCount` and `agentId` are unchanged.
- From Review with a running session: error, nothing started or moved.
- Backlog start without `--message`: prompt unchanged (regression).
- Sidebar prompt contains the new `task start` guidance.
