# Plan: UI contrast and Done history polish

Spec: `docs/superpowers/specs/2026-10-30-ui-contrast-and-history-polish-design.md`

Two independent Kanban tasks, run in parallel. They touch disjoint files.

## Task A (OpenCode): tokens, board, shared styles — spec A1–A7
Files: `web-ui/src/styles/globals.css`, `web-ui/src/components/board-card.tsx`, `web-ui/src/utils/task-prompt.ts`, `web-ui/src/components/project-navigation-panel.tsx`, `web-ui/src/components/detail-panels/agent-terminal-panel.tsx`, `web-ui/src/components/detail-panels/cline-agent-chat-panel.tsx`, `web-ui/src/components/top-bar.tsx`, and their existing test files plus one new token-contrast test.
1. Contrast test for the default-theme tokens (fails first), then raise the two tokens.
2. `normalizePromptForDisplay` tests (fail first), then strip markdown markers.
3. Done card style, project path size/colour, Move button variant, task pluralisation, diff row padding.
4. Verify: typecheck, lint, test:fast, web-ui tests.

## Task B (Antigravity): Done task history view — spec B1–B5
Files: `web-ui/src/components/done-task-detail-view.tsx` and its test file (create one next to it if none exists).
1. Badge background, timeline sizing, prompt box styling.
2. Transcript drawer: backdrop, `role="dialog"`, Escape and backdrop click close.
3. Collapse injected-instruction turns.
4. Verify: typecheck, lint, test:fast, web-ui tests.
