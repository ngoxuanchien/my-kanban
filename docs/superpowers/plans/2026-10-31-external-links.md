# Plan: open external links from the desktop app

Spec: `docs/superpowers/specs/2026-10-31-external-links-design.md`

One Kanban task.

## Task 1: Terminal link handler + will-navigate opens externally
Files: `web-ui/src/terminal/persistent-terminal-manager.ts`, `packages/desktop/src/window-registry.ts`, `packages/desktop/test/window-registry.test.ts`.
1. Tests first in `window-registry.test.ts`: cross-origin http(s) `will-navigate` → prevented and `shell.openExternal(url)` called; same-origin → not prevented, not opened; `javascript:` / `file:` → prevented, not opened.
2. `window-registry.ts`: extract a local `openExternalSafe(url)` (openExternal + `.catch` warn), use it in `setWindowOpenHandler` and in the cross-origin http(s) branch of `will-navigate`.
3. `persistent-terminal-manager.ts:193`: `new WebLinksAddon((_event, uri) => { window.open(uri, "_blank", "noopener,noreferrer"); })`.
4. Verify: typecheck, lint, test:fast, desktop package tests.
