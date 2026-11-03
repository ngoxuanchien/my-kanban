# Plan: restart a stopped Review task with `task start`

Spec: `docs/superpowers/specs/2026-11-03-start-task-from-review-design.md`

One Kanban task.

## Task 1: `task start` from Review with `--message`
1. `src/commands/task.ts` `startTask()` (~line 847): allow `review` when the session is not running; error when it is running. Add `message?: string`. Build the start prompt with a small exported helper (e.g. `buildRestartPrompt({ originalPrompt, baseRef, message })`) modeled on `buildHandOffPrompt()`; use it for Review starts and whenever `--message` is given. Wire `--message <text>` on the `start` command (~line 1587).
2. `src/prompts/append-system-prompt.ts`: update the `task start` section (~line 312) and review steps 3-4 (~lines 346-347) as the spec says.
3. Tests in `test/runtime/` next to the existing task command tests (see `test/runtime/task-command-agent-id.test.ts`, `test/runtime/server/hand-off-task.test.ts`) for the cases in the spec; update prompt string tests if any. Any test spawning git uses `env: createGitTestEnv()`.

Acceptance: `npm run typecheck && npm run lint && npm run test:fast`.
