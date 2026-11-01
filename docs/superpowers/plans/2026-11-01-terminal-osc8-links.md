# Plan: terminal OSC 8 links

Spec: `docs/superpowers/specs/2026-11-01-terminal-osc8-links-design.md`. One Kanban task.

## Task 1: Custom xterm linkHandler
Files: `web-ui/src/terminal/terminal-options.ts`, `web-ui/src/terminal/terminal-options.test.ts`, `web-ui/src/terminal/persistent-terminal-manager.ts`.
1. Test first in `terminal-options.test.ts`: with `window.open` and `window.confirm` spied,
   `options.linkHandler.activate(event, "https://api.githubcopilot.com", range)` calls
   `window.open("https://api.githubcopilot.com", "_blank", "noopener,noreferrer")` once and never calls `confirm`;
   `file:///etc/passwd`, `javascript:alert(1)` and `not a url` call neither.
2. Add exported `openTerminalLink(uri: string): void` and `linkHandler` (with `allowNonHttpProtocols: false`) in `createKanbanTerminalOptions`.
3. Replace the inline `WebLinksAddon` callback in `persistent-terminal-manager.ts:193-197` with `(_event, uri) => openTerminalLink(uri)`.
4. Verify: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm --prefix web-ui run test -- terminal-options`.
