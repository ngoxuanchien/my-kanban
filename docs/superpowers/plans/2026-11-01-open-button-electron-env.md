# Plan: top-bar Open button strips ELECTRON_RUN_AS_NODE

Spec: `docs/superpowers/specs/2026-11-01-open-button-electron-env-design.md`
One Kanban task (codex).

## Steps
1. `runScopedCommand` lives in `src/cli.ts:316` and is not exported, so it cannot be tested. Move it unchanged into a new module `src/server/run-scoped-command.ts`, export it, and import it in `src/cli.ts` (`:450`, `runCommand: runScopedCommand`).
2. Write the failing test `test/runtime/run-scoped-command.test.ts`. With `process.env.ELECTRON_RUN_AS_NODE = "1"` (restored afterwards), `runScopedCommand("printenv ELECTRON_RUN_AS_NODE || echo unset", <tmp dir>)` returns `stdout` `unset`. Run it and confirm it fails.
3. Spawn with `env: { ...process.env }` minus `ELECTRON_RUN_AS_NODE`, built as a copy so `process.env` is not mutated. The test passes.
4. Run `npm run typecheck`, `npm run lint` and `npm run test:fast`.
