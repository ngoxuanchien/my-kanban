# Empty task nudge — plan

Spec: `docs/superpowers/specs/2026-10-29-empty-task-nudge-design.md`

One Kanban task (Codex), sidebar review on.

1. Write the 4 tests from the spec in `test/runtime/server/sidebar-review-service.test.ts` (mock `runGit` and `sendPromptToSession` the same way the file already mocks its dependencies).
   → verify: `npx vitest run test/runtime/server/sidebar-review-service.test.ts` fails on the new tests.
2. In `src/server/sidebar-review-service.ts`, add the worktree check and the nudge before the round mutation in `handleSummary`; keep a `nudgedTaskIds` set; clear it on wake and in `notifyBoardChanged` for tasks that leave review.
   → verify: the test file passes.
3. `npm run typecheck`, `npm run test:fast`, `npm run lint`, `npx @biomejs/biome check src test`.
