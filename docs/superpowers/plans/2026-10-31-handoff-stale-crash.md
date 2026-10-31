# Plan: ignore the stopped session's crash after a handoff

Spec: `docs/superpowers/specs/2026-10-31-handoff-stale-crash-design.md`

One Kanban task.

## Task 1: Crash handoff only for the card's current agent
Files: `src/server/sidebar-review-service.ts`, `test/runtime/server/sidebar-review-service.test.ts`.
1. `git apply ~/.cline/kanban-patches/6e542-handoff-stale-crash-test.patch`; confirm the new test fails.
2. In the crash branch (`sidebar-review-service.ts:523`), return before `deps.handOffTask` when `summary.agentId` is set and differs from `found.card.agentId`.
3. Verify: the sidebar-review-service tests, typecheck, lint, test:fast.
