# Plan: accept both loopback origins

Spec: `docs/superpowers/specs/2026-10-30-localhost-origin-design.md`

One Kanban task.

## Task 1: Origin gate accepts localhost and 127.0.0.1 in local mode
Files: `src/server/middleware.ts`, `test/runtime/server/middleware.test.ts`.
1. Tests first: update `evaluateCors` cases to pass `allowedOrigins` (a set); add local-mode cases for `http://localhost:<port>` and `http://127.0.0.1:<port>` (HTTP and `handleSocketUpgrade`), still rejecting other ports/schemes; add a remote-mode case rejecting `localhost`.
2. Add `getAllowedOrigins()` mirroring `getAllowedHostHeaders()` (local: both loopback names; remote: `getKanbanRuntimeOrigin()` only). Switch `evaluateCors` to `allowedOrigins: ReadonlySet<string>` and both call sites to `getAllowedOrigins()`. Keep the dev-server 4173 exception.
3. Verify: typecheck, lint, test:fast.
