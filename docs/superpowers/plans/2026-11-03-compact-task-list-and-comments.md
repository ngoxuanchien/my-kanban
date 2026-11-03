# Plan: compact `task list` and task comments

Spec: `docs/superpowers/specs/2026-11-03-compact-task-list-and-comments-design.md`

Two chained Kanban tasks (both touch `src/commands/task.ts`): task 2 waits on task 1.

## Task 1: compact `task list` + `task show`
1. `src/commands/task.ts`: add a text formatter for `listTasks` (rows, Done trimmed to 3 + count line, links, last created) and print it as plain text by default; `--json` compact rows; `--full` old JSON. Keep error output JSON. `runTaskCommand` needs a text-printing variant.
2. Add `task show --task-id <id> [--project-path]` returning `formatTaskRecord(...)` for one task.
3. `src/prompts/append-system-prompt.ts`: update `task list`, add `task show`, review step 1 uses `task show`.
4. Tests in `test/runtime/` (see `test/runtime/task-command-agent-id.test.ts` for CLI mocks).
Acceptance: `npm run typecheck && npm run lint && npm run test:fast`.

## Task 2: task comments
1. `src/state/task-history.ts`: `comment` event type (type guard, `detail` cap 2,000 chars).
2. `src/commands/task.ts`: `task comment` (task id from `--task-id` or `KANBAN_HOOK_TASK_ID`); `task show` adds `comments`.
3. Append recent comments (≤ ~3,000 chars) in `buildHandOffPrompt` and `buildRestartPrompt`.
4. `src/trpc/runtime-api.ts` `startTaskSession`: append the `[Kanban notes]` footer once to the prompt sent to the agent.
5. Web UI: `comment` label in `getEventDisplayInfo` (`web-ui/src/components/done-task-detail-view.tsx`) and the `RuntimeTaskHistoryEvent` type/schema in `src/core/api-contract.ts`.
6. Tests from the spec (runtime + web-ui).
Acceptance: `npm run typecheck && npm run lint && npm run test:fast`, and `cd web-ui && npm run typecheck && npm run test`.
