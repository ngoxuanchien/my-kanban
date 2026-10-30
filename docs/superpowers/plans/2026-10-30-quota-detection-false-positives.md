# Plan: quota detection false positives

Spec: `docs/superpowers/specs/2026-10-30-quota-detection-false-positives-design.md`. One Kanban task, after "Quota: phrase-free handoff reason (retry of 7a7fb)" (f6c0b) is merged, since both edit `src/server/sidebar-review-service.ts`.

## Task 1 — Quiet screen rule + Antigravity log
Files: `src/server/usage-limit-detector.ts`, `src/server/antigravity-log-usage-limit.ts` (new), `src/server/sidebar-review-service.ts`, `test/runtime/server/usage-limit-detector.test.ts`, `test/runtime/server/antigravity-log-usage-limit.test.ts` (new), `test/runtime/server/sidebar-review-service.test.ts`.

Tests first:
1. `detectUsageLimit`: phrase in the last 10 lines → match; phrase on line 11 from the bottom → `null`; `Individual quota reached` matches.
2. `findAntigravityLogUsageLimit`: matching worktree + E line after `sinceMs` → phrase; other worktree → `null`; file older than `sinceMs - 60 s` → `null`; `I` line with the text → `null`.
3. Service, running task: phrase on screen and last output 5 s ago → no handoff, no nudge; phrase on screen and last output 31 s ago → handoff as today.
4. Service, antigravity task, screen clean, fake `readAntigravityLogs` returns a matching file → usage-limit path runs; codex task never calls either log reader.

Then implement per the spec and run `npm run typecheck`, `npm run lint`, `npm run test:fast`.
