# Plan: OpenCode log quota detection and immediate handoff

Spec: `docs/superpowers/specs/2026-10-30-opencode-log-quota-design.md`

One Kanban task.

## Task 1: detect quota in the OpenCode log; hand off at once on a quota phrase
Files: `src/server/opencode-log-usage-limit.ts` (new), `test/runtime/server/opencode-log-usage-limit.test.ts` (new), `src/server/sidebar-review-service.ts`, `test/runtime/server/sidebar-review-service.test.ts`.
1. Tests first: parser cases from spec §5; service cases (log hit → immediate handoff, screen phrase → immediate handoff, silent → `continue` first).
2. Write the parser and the tail reader (≤ 2 MiB, XDG path, never throws).
3. Add one usage-limit helper in the service (screen, then OpenCode log for opencode tasks) and use it at every terminal-snapshot `detectUsageLimit` call site. Inject the log reader through the service deps so tests do not touch the real file.
4. In `handleUsageLimit`, skip the `continue` nudge when `phrase` is set.
5. Verify: typecheck, lint, biome, test:fast.
