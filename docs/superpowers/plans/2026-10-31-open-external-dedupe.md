# Plan: one shared openExternalSafe in the desktop package

Follow-up to `docs/superpowers/specs/2026-10-31-external-links-design.md` (task d2118). No behavior change, so no separate spec.

One Kanban task.

## Task 1: Move openExternalSafe to its own module
Files: `packages/desktop/src/open-external.ts` (new), `packages/desktop/src/app-menu.ts`, `packages/desktop/src/window-registry.ts`.
1. Create `open-external.ts` exporting `openExternalSafe(url: string): void` (body and doc comment moved from `app-menu.ts:7-21`).
2. Delete the local copies in `app-menu.ts` and `window-registry.ts`; import from `./open-external.js`. Drop `shell` from each file's electron import if it becomes unused.
3. Verify: desktop `npm run typecheck` and `npm test`, root `npm run typecheck`, `npm run lint`, `npm run test:fast`.
