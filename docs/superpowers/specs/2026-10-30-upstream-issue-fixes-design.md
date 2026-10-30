# Fixes for four upstream cline/kanban issues

Date: 2026-10-30
Status: approved (user, 2026-10-30)
Source: scan of open issues on https://github.com/cline/kanban/issues (fork is at 0.1.70, same as the reports).

## 1. Problem
Five open upstream bugs (four fixed here) exist unchanged in this fork and hit the sidebar-review workflow directly. **[assistant's scan, user approved fixing all four]**

| Issue | Defect in this fork |
|---|---|
| #665 (dups #542, #610) | `src/terminal/ws-server.ts:81-82` pauses the shared PTY once a viewer has ≥100 KB unacked output and resumes only when **every** paused viewer drops below 5 KB. No timeout. One throttled/frozen tab (or the Electron window plus a browser tab, or a sleeping laptop) freezes the agent forever — including the sidebar reviewer. |
| #674 | (a) `web-ui/src/runtime/use-workspace-persistence.ts:130` sets the UI revision to the server revision **before** refetching, so `applyWorkspaceState` (`web-ui/src/hooks/use-workspace-sync.ts:115`) sees equal revisions, keeps the stale board, and the next save overwrites the server. CLI-created cards vanish, CLI-deleted cards come back. (b) `performMoveTaskToTrash` (`web-ui/src/hooks/use-linked-backlog-task-actions.ts:105`) stops the session and deletes the worktree right away, while the move itself is only saved by the 120 ms debounced save; if that save is lost the card stays in Review with no session and no worktree. |
| #623 | `src/cli.ts:748` calls `process.exit()` right after a command wrote its JSON with `process.stdout.write` (`src/commands/task.ts:67`). On a pipe, output past 64 KiB is dropped. Reproduced on this Mac: writing 200 KB then `process.exit(0)` piped to `wc -c` gives `65536` 5/5 times. Boards with long template prompts will exceed 64 KiB, and the sidebar then parses a truncated `task list`. |
| #128 / #535 | `src/fs/locked-file-system.ts:54-55` only sets `onCompromised` when a caller passes one; none does. `proper-lockfile`'s default handler throws inside a timer, an uncaught exception that kills the runtime under CPU pressure. |
| #619 | `src/workspace/task-worktree.ts:21-29` symlinks every gitignored path into task worktrees except a few OS files, so a `.env` with secrets is exposed in every task worktree. |

## 2. Goals
- G1 (#665). A viewer that stops acking cannot hold the PTY paused. If a paused viewer makes no ack progress for `OUTPUT_ACK_STALL_TIMEOUT_MS = 5_000`, the server drops it from `backpressuredViewerIds` (resuming the PTY if it was the last one), stops sending it output, and closes its io and control sockets with close code `4000` (`"Terminal viewer stalled."`). The web-ui terminal reconnects automatically on close code `4000` (io and control), which runs the normal restore path and resets the unacked count. Other close codes keep today's behavior. **[assistant's call]**
- G2 (#674a). On a save conflict the UI does not set the revision before refetching; the refetch must hydrate the server board. The local unsaved edit is dropped (server wins), and the existing conflict toast stays. **[assistant's call]**
- G3 (#674b). Move to Done is saved on the server before any side effect. New tRPC mutation `workspace.moveTaskToDone({ taskId })` does only the board move under the workspace lock (`mutateWorkspaceState` + `trashTaskAndGetReadyLinkedTaskIds` from `src/core/task-board-mutations.ts`), broadcasts the state update, and returns `{ ok, moved, readyTaskIds, state }` (`state` is the saved `RuntimeWorkspaceStateResponse`). `performMoveTaskToTrash` calls it first and applies the returned state; only when `ok` is true does it start ready linked tasks (using the server's `readyTaskIds`), stop the session(s), and clean up the worktree. If the call fails, it shows an error toast and does nothing else. **[assistant's call; mirrors the CLI path in `src/workspace/complete-task-to-done.ts`]**
- G4 (#623). The CLI drains stdout and stderr before `process.exit` in `run()` (`src/cli.ts:748`) and in the startup error path (`src/cli.ts:757`). Piping a >64 KiB `task list` gives complete, valid JSON every time. **[assistant's call]**
- G5 (#128). `createLockOptions` always sets `onCompromised`: it calls the caller's handler when given, otherwise logs a warning and does not throw. **[upstream suggestion in #535]**
- G6 (#619). **Dropped (user, 2026-10-30):** the user's projects need `.env` inside task worktrees for tests and dev servers, and agents can read the main checkout's `.env` anyway, so `.env` keeps being symlinked.

## 3. Non-goals
- #129 polling intervals, #581 scrollback size, #648 large prompts, #574 OSC 52 clipboard, #644 Claude permission mode (tracked in `contexte/upstream-issues.md`, not fixed here).
- A server-side trash that also stops sessions and starts tasks (UI keeps doing those, after the save).
- Recovering the local edit that lost a save conflict.

## 4. Design notes
- G1: track `lastAckProgressAt` per io output state; arm a stall timer when the viewer pauses, re-arm on every ack, clear on resume/dispose. On stall, run the same cleanup as `dispose()` before closing so the PTY resumes immediately even if the close handshake to a frozen tab never completes. Client side: in `web-ui/src/terminal/persistent-terminal-manager.ts` `ioSocket.onclose` / `controlSocket.onclose`, when `event.code === 4000` and not disposed, clear the socket and call `ensureConnected()` instead of setting the "Close and reopen" error.
- G3: `RuntimeWorkspaceStateResponse` and the schemas live in `src/core/api-contract.ts`; procedures in `src/trpc/app-router.ts` (next to `deleteWorktree`) delegate to `src/trpc/workspace-api.ts`, which already has `broadcastRuntimeWorkspaceStateUpdated`.
- G4: `await new Promise((resolve) => process.stdout.write("", () => resolve()))` (and the same for stderr) resolves after earlier writes are flushed.

## 5. Tests
- G1: `test/runtime/terminal/ws-server.test.ts` — two viewers, one never acks → PTY resumes within the timeout and the stalled viewer gets close code 4000; a viewer that keeps acking is unaffected. Web-ui test: close code 4000 reconnects, other codes set the error.
- G2/G3: web-ui hook tests for the conflict path (stale board not re-sent; server board hydrated) and for Move to Done (no stop/cleanup when the mutation fails; stop/cleanup after it succeeds). Runtime test for `moveTaskToDone`.
- G4: test that spawns the CLI entry (or a helper) writing >64 KiB to a pipe and gets all bytes.
- G5: `test/runtime/locked-file-system.test.ts` — default options contain a non-throwing `onCompromised`; a caller handler is still called.
