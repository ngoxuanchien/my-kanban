# Terminal OSC 8 links open in the system browser

Follow-up to `2026-10-31-external-links-design.md`.

## Problem
Agents such as Claude Code print hyperlinks with the OSC 8 escape sequence
(e.g. `https://api.githubcopilot.com` in `/mcp` output). Kanban sets no
`linkHandler` on the xterm `Terminal`, so xterm's default OSC 8 handler runs:
it shows `confirm("Do you want to navigate to …? WARNING: This link could
potentially be dangerous")`, then calls `window.open()` with no URL. The desktop
`setWindowOpenHandler` sees `about:blank`, denies it, and xterm logs
"Opening link blocked as opener could not be cleared". The link never opens.

The previous fix only covered plain-text URLs detected by `WebLinksAddon`.

## Design
- `web-ui/src/terminal/terminal-options.ts`: export `openTerminalLink(uri)` that
  calls `window.open(uri, "_blank", "noopener,noreferrer")` only for `http:` /
  `https:` URLs (anything else, or an unparseable URI, is ignored).
- `createKanbanTerminalOptions` sets `linkHandler: { activate: (_e, uri) => openTerminalLink(uri), allowNonHttpProtocols: false }`.
  No confirm dialog.
- `persistent-terminal-manager.ts`: `WebLinksAddon` uses `openTerminalLink`
  instead of its inline `window.open` so both link kinds share one path.
- Desktop side needs no change: `setWindowOpenHandler` already sends http(s) to
  `shell.openExternal`.

## Out of scope
File paths / `file://` links, custom schemes.
