# Plan: terminal file links open in VS Code

Spec: `docs/superpowers/specs/2026-11-01-terminal-file-links-vscode-design.md`. One Kanban task.

## Task 1: Runtime endpoint + terminal file link handler
Files: `src/server/editor-link.ts` (new), `test/runtime/server/editor-link.test.ts` (new), `src/core/api-contract.ts`, `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`, `web-ui/src/terminal/terminal-options.ts`, `web-ui/src/terminal/terminal-options.test.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`.
1. Tests first: `editor-link.test.ts` (temp dirs, no git) — file inside allowed root → `vscode://file/<real>:12:3`; outside → rejected; missing → rejected; relative → rejected; `..` escaping the root → rejected; a path with a space is URI-encoded.
2. `editor-link.ts`: `resolveEditorFileUrl({ path, line, column }, allowedRoots): Promise<string>` throwing typed errors; runtime-api maps them to TRPCError and calls `openInBrowser(url)`.
3. Contract schemas + `runtime.openFileInEditor` workspaceProcedure.
4. web-ui tests first: `parseTerminalFileLink` cases from the spec; `linkHandler.activate` with a `file://` URI calls `onFileLink` and not `window.open`; https still calls `window.open`.
5. Wire `onFileLink` in `persistent-terminal-manager.ts` with an error toast.
6. Verify: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm --prefix web-ui run typecheck`, `npm --prefix web-ui run test -- terminal-options`.
