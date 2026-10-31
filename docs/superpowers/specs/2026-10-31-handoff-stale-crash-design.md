# Ignore the stopped session's crash after a handoff

Date: 2026-10-31
Status: approved (user asked for a fix, 2026-10-31)

## 1. Problem
One sidebar `task handoff` on task a641a moved it opencode → antigravity → codex and set `handOffCount` to 2.

`handOffTask` (`src/server/hand-off-task.ts:59-120`) stops the old session, switches the card's `agentId`, and starts the new agent. The stopped old session then reports `state: "failed"` (or a non-zero exit). The crash branch in `src/server/sidebar-review-service.ts:508-525` treats that as a crash of the task and hands off again. It never checks that the crashed session's `summary.agentId` is the card's current `agentId`, which the first handoff already changed.

Investigation task 6e542 wrote a regression test that fails on main: "ignores a stopped OpenCode session crashing after handoff to Antigravity" (`test/runtime/server/sidebar-review-service.test.ts`), saved as `~/.cline/kanban-patches/6e542-handoff-stale-crash-test.patch`.

## 2. Goals
- G1. A crash summary whose `agentId` is set and differs from the card's `agentId` triggers no handoff (it comes from a session that was already replaced).
- G2. A real crash of the current agent still hands off as today (existing tests unchanged).

## 3. How (decided)
In the crash branch, before calling `deps.handOffTask`, return when `summary.agentId` is set and `summary.agentId !== found.card.agentId`. When `summary.agentId` is missing, keep today's behavior.

## 4. Non-goals
- Changing `handOffTask`, the cap, or quota handoff.

## 5. Verification
- Apply the patch; the new test passes, and so do all existing `sidebar-review-service` tests.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`.
