# UI contrast and Done history polish

Date: 2026-10-30
Status: approved (user, 2026-10-30)

## 1. Problem
An `impeccable` overlay audit of four screens (Done task history, board, sidebar agent, task detail) flagged ~100 warnings. Checked against the DOM and source, they reduce to the findings below. Contrast was measured with `getComputedStyle` (WCAG ratio; 12–14px text needs ≥ 4.5:1).

Root cause of most contrast warnings: two text tokens in `web-ui/src/styles/globals.css:19-20` (default theme):
- `--color-text-tertiary: #6E7681` → 3.19–3.41:1 on `surface-0/1/2`.
- `--color-text-secondary: #8B949E` → 4.15:1 on `surface-2` (#2D3339), 3.63:1 on `surface-3` (#353C43).

## 2. Findings in scope
Task A — tokens, board, shared styles:
- A1. Raise `--color-text-secondary` and `--color-text-tertiary` in the default theme so both reach ≥ 4.5:1 on `surface-0`, `surface-1`, `surface-2`, keeping secondary visibly brighter than tertiary. Other themes in `globals.css` are out of scope. **[assistant's call]**
- A2. Done cards look deleted: `web-ui/src/components/board-card.tsx:597,623` apply `line-through text-text-tertiary` to every card in the done/trash column. Done cards drop `line-through` and use `text-text-secondary`.
- A3. Cards show raw markdown (`## Goal …`, `**Implemented** …`). `normalizePromptForDisplay` (`web-ui/src/utils/task-prompt.ts:15`) strips markdown markers for display: leading `#` headings, `**`/`__` emphasis, inline backticks. The agent's last-message line on the card uses the same normalisation.
- A4. Project path in the project list is `font-mono text-[10px]` (`web-ui/src/components/project-navigation-panel.tsx:769`): raise to `text-xs`; the selected row (on accent blue) measured 3.38:1 — give it a colour that reaches ≥ 4.5:1.
- A5. "Move Card To Done" uses `variant="danger"` (`web-ui/src/components/detail-panels/agent-terminal-panel.tsx:332`, same label in `cline-agent-chat-panel.tsx:494`): use `variant="default"`; moving to Done is not destructive.
- A6. Top bar shows `(11 task)`: `web-ui/src/components/top-bar.tsx:550` pluralises (`1 task`, `2 tasks`).
- A7. Diff rows have no horizontal padding, so highlights touch the code (`.kb-diff-row` `padding: 1px 2px 1px 0` in `globals.css:540-548`): give the row a small left/right padding.

Task B — Done task history view (`web-ui/src/components/done-task-detail-view.tsx`):
- B1. "Read-only history" badge (`:326`, `bg-surface-3 text-text-secondary`, 3.63:1): use `bg-surface-2` so it reaches ≥ 4.5:1 with the new token.
- B2. Timeline section (`:359`, `flex flex-1`) takes half the height while holding two rows; the diff below gets squeezed. Timeline sizes to content with a cap (e.g. `shrink-0 max-h-[40%] overflow-y-auto`); the diff takes the rest.
- B3. Prompt box (`:348`) is a bordered card inside the sidebar, `font-mono`: drop the border/background and `font-mono`; keep `whitespace-pre-wrap`.
- B4. Transcript drawer (`:487`) overlays the diff without a backdrop, `role="dialog"`, or Escape to close: add all three; clicking the backdrop closes it.
- B5. First transcript turn is the agent's injected instructions (text starting with `# AGENTS.md instructions` or containing `<INSTRUCTIONS>`): render such turns collapsed to one line ("Injected instructions") that expands on click.

## 3. Non-goals / false positives (recorded so nobody re-chases them)
- `transition: height` and a `#ad0000` glow: no such rule in the app's CSS; the only transition rule found is from `sonner`.
- "Overused font: Geist": design choice.
- "Nested cards" boxes at fixed coordinates (1141,93 / 1141,283) and "content overflowing" at 0×0: overlay artefacts, nothing in the app at those points.
- Diff row height (19px) is normal density; only the missing horizontal padding (A7) is fixed.
- Sidebar terminal width: already resizable 200–600 px (`web-ui/src/resize/use-project-navigation-layout.ts:16-18`), terminal font 13 px.

## 4. Verification
- A1: a unit test parses the default-theme tokens from `globals.css` and asserts WCAG contrast ≥ 4.5 for `text-secondary` and `text-tertiary` on `surface-0`, `surface-1`, `surface-2`.
- A3: unit tests for `normalizePromptForDisplay` with headings, bold, inline code.
- A6, A2, B1–B5: component tests where the file already has a test; otherwise a short manual check listed in the task's final message.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, and the web-ui tests.
