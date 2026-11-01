# Terminal file links open in VS Code

Follow-up to `2026-11-01-terminal-osc8-links-design.md`.

## Problem
Clicking an OSC 8 `file://` link in a task or sidebar terminal does nothing:
`openTerminalLink` (`web-ui/src/terminal/terminal-options.ts`) only opens
http(s). Users want the file opened in VS Code, at the line when one is given.

## Decision
- Editor is VS Code only, opened through the `vscode://file/<abs>:<line>:<col>`
  URL. No dependency on the `code` CLI being on PATH; no desktop change.
- Opening a file in an editor never executes it, but the runtime is still the
  trust boundary: it only opens existing paths inside the current workspace or
  inside the Kanban task worktrees home (`getTaskWorktreesHomePath()`).

## Design
### Runtime
- `src/core/api-contract.ts`: `runtimeOpenFileInEditorRequestSchema = { path: string, line?: positive int, column?: positive int }`, response `{ ok: boolean }`.
- `src/trpc/app-router.ts`: `runtime.openFileInEditor` as a `workspaceProcedure` mutation.
- `src/trpc/runtime-api.ts` `openFileInEditor(workspaceScope, input)`:
  1. Reject a non-absolute path (BAD_REQUEST).
  2. `realpath` it (missing → BAD_REQUEST "File not found").
  3. Allow only if the real path equals or is inside `realpath(workspaceScope.workspacePath)` or `realpath(getTaskWorktreesHomePath())`; otherwise FORBIDDEN.
  4. `openInBrowser(\`vscode://file${encodeURI(real)}${line ? \`:${line}${column ? \`:${column}\` : ""}\` : ""}\`)`, return `{ ok: true }`.
  Keep the path logic in a small exported helper (e.g. `src/server/editor-link.ts`) so it is unit-testable without tRPC.

### web-ui
- `terminal-options.ts`: `parseTerminalFileLink(uri)` turns `file:///abs/path`, `file:///abs/path:12`, `file:///abs/path:12:3`, `file:///abs/path#L12` into `{ path, line?, column? }` (percent-decoded); anything else → `null`.
- `createKanbanTerminalOptions` gains an optional `onFileLink(link)` input. `linkHandler.activate` calls it for parsed file links, else `openTerminalLink`. Set `allowNonHttpProtocols: true` so xterm passes `file:` links to the handler; `openTerminalLink` still ignores other schemes.
- `persistent-terminal-manager.ts` passes `onFileLink` that calls `trpcClient.runtime.openFileInEditor.mutate(...)` for its `workspaceId`; on error show `showAppToast` (intent danger) with the message.

## Out of scope
Plain-text paths (`src/foo.ts:12` without OSC 8), other editors / the open-target picker, relative paths.
