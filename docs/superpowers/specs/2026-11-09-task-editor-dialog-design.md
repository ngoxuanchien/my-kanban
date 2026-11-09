# Large task editor dialog (create and edit Backlog tasks)

Date: 2026-11-09. Size: 1 Kanban task, no separate plan.

## Why
Writing a long prompt, or re-reading a Backlog task, is cramped:
- The create dialog is `max-w-2xl` (~672px) (`web-ui/src/components/task-create-dialog.tsx:475`), and the prompt textarea stops growing at 200px (`TEXTAREA_MAX_HEIGHT`, `web-ui/src/components/task-prompt-composer.tsx:26`).
- Editing a Backlog task opens `TaskInlineCreateCard` inside the column (`web-ui/src/App.tsx:797`, rendered by `board-column.tsx:165` and `card-detail-view.tsx:846`), so it is only as wide as a column.

## Goals
1. The create dialog is large: about 90% of the viewport width and height.
2. Inside the dialog, the prompt textarea fills most of the dialog height; no 200px cap there.
3. Editing a Backlog task opens the same large dialog in an edit mode, instead of the inline card in the column.

## Edit mode behavior
- Title "Edit task"; prompt, images, and every option (agent, model, reasoning effort, difficulty, branch, plan mode, auto review, agent review) prefilled and saved exactly as the inline editor does today (same `use-task-editor.ts` state and handlers: `handleSaveEditedTask`, `handleSaveAndStartEditedTask`, `handleCancelEditTask`).
- Hides create-only controls: split into multiple tasks, "create more", "start and open".
- Buttons: Save and Save & Start, with the same shortcuts the inline editor uses.
- Closing the dialog (Esc, overlay, close button) cancels the edit like the inline Cancel does.
- No inline editor appears in the column while the dialog is open.

## Non-goals
- No change for In Progress, Review, or Done tasks.
- No change to save logic, board state, runtime, or CLI.
- No new dialog component: extend `TaskCreateDialog` with an edit mode.

## Builder's calls (decided by the planner)
- Size: about 90vw × 90vh; options stay below the prompt as today.
- The 200px cap stays for any other composer usage; only the dialog lifts it (for example via a composer prop).
- If `TaskInlineCreateCard` has no remaining caller after the change, remove it and its now-unused props/wiring; otherwise leave it.
