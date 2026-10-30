# Plan: handoff reason must not re-trigger quota detection

Spec: `docs/superpowers/specs/2026-10-30-handoff-reason-self-trigger-design.md`. One Kanban task.

## Task 1 — Phrase-free handoff reason
Files: `src/server/sidebar-review-service.ts`, `test/runtime/server/sidebar-review-service.test.ts`.

1. Tests first (in the existing usage-limit handoff tests near lines 800–860):
   - `handOffTask` is called with exactly `The previous agent hit its usage limit.`
   - The recorded history event `detail` is still `The previous agent hit its usage limit ("<phrase>").`
   - New test: `detectUsageLimit` (from `src/server/usage-limit-detector.ts`) returns `null` for the reason string passed to `handOffTask`.
2. In `src/server/sidebar-review-service.ts` around line 285, pass the phrase-free reason to `handOffTask` and keep the phrase in the history `detail`.
3. Run `npm run typecheck`, `npm run lint`, `npm run test:fast`.
