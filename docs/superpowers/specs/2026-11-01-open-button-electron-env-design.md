# Top-bar Open button: strip ELECTRON_RUN_AS_NODE — design

Date: 2026-11-01
Status: approved in chat by the user

## Problem

The top-bar **Open** button (`web-ui/src/hooks/use-open-workspace.ts:84-95`) asks the runtime to run `open -a 'Visual Studio Code' <path>` through `runtime.runCommand`, which calls `runScopedCommand` (`src/cli.ts:316-326`). That spawns the shell with `env: process.env`.

In the desktop app the runtime runs with `ELECTRON_RUN_AS_NODE=1`. Evidence, from the running app on 2026-11-01:
- `runtime.runCommand` with `env | grep -i electron` → `ELECTRON_RUN_AS_NODE=1`.
- macOS `open` passes the caller's environment to the app it launches. VS Code is an Electron app, so with that variable it starts as plain Node, gets the editor arguments, and exits at once. The user sees the Dock icon bounce and nothing opens. Running the VS Code binary in that environment prints `bad option: --verbose` and exits 9.
- `env -u ELECTRON_RUN_AS_NODE open -a 'Visual Studio Code' <path>` opens VS Code, and it keeps running.

Cursor and Windsurf, also Electron apps, take the same path and are expected to fail the same way.

## Fix

Commands run by `runScopedCommand` get the runtime environment **without `ELECTRON_RUN_AS_NODE`**. Nothing else changes.

## Non-goals
- Task and sidebar agent terminals keep the variable. The sidebar runs the Kanban CLI as `Kanban cli.js …` and needs it.
- `src/update/update.ts` and `src/commands/hooks.ts` spawns are unchanged.

## Acceptance
- A test runs `env` (or `printenv ELECTRON_RUN_AS_NODE`) through `runScopedCommand` with `process.env.ELECTRON_RUN_AS_NODE = "1"` set, and asserts that the output does not contain the variable. The test fails before the fix.
- `npm run typecheck`, `npm run lint`, `npm run test:fast` pass.
