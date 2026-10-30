# Plan: fixes for four upstream issues

Spec: `docs/superpowers/specs/2026-10-30-upstream-issue-fixes-design.md`

Three independent Kanban tasks; no shared files, so they run in parallel.

## Task 1: stalled terminal viewer cannot freeze the PTY (#665, G1)
Files: `src/terminal/ws-server.ts`, `test/runtime/terminal/ws-server.test.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`, its test file.
1. Failing test: two viewers, one never acks → PTY resumes within the timeout, stalled viewer closed with 4000; acking viewer unaffected.
2. Add `OUTPUT_ACK_STALL_TIMEOUT_MS`, stall timer in `createIoOutputState`, cleanup + close io/control with 4000.
3. Web-ui: reconnect on close code 4000; test both 4000 and other codes.
4. Verify: typecheck, web:typecheck, lint, test:fast, web:test.

## Task 2: board writes are not lost (#674, G2 + G3)
Files: `web-ui/src/runtime/use-workspace-persistence.ts`, `web-ui/src/hooks/use-workspace-sync.ts` (only if needed), `web-ui/src/hooks/use-linked-backlog-task-actions.ts`, `src/core/api-contract.ts`, `src/trpc/app-router.ts`, `src/trpc/workspace-api.ts`, matching tests.
1. Failing web-ui test: conflict path hydrates the server board and does not re-send the stale board. Fix by not calling `onWorkspaceRevisionChange` before the refetch.
2. Failing runtime test, then `workspace.moveTaskToDone` mutation (board move under lock, broadcast, return state + readyTaskIds).
3. Failing web-ui test, then `performMoveTaskToTrash` calls the mutation first; side effects only on success; toast on failure.
4. Verify: typecheck, web:typecheck, lint, test:fast, web:test.

## Task 3: CLI output and lock safety (#623 + #128, G4 + G5)
Files: `src/cli.ts`, `src/fs/locked-file-system.ts`, `test/runtime/locked-file-system.test.ts`, a new test for stdout draining.
1. Failing test: >64 KiB through a pipe arrives complete. Drain stdout/stderr before `process.exit` in `run()` and the startup error path.
2. Failing test: default lock options have a non-throwing `onCompromised`; caller handler still used. Fix `createLockOptions`.
3. Verify: typecheck, lint, test:fast.

Task 4 (#619, `.env` symlinks) was dropped; see spec G6.
