# Done history: single top bar and resizable panels

Date: 2026-10-30
Status: approved (user, 2026-10-30)

## 1. Problem
The Done task history view (`web-ui/src/components/done-task-detail-view.tsx`) has two issues:
- It renders its own header bar (`Back` button + "Done Task" + "Read-only history" badge) under the app `TopBar`, which already shows a back-to-board arrow when a card is selected (`web-ui/src/App.tsx:846`, `web-ui/src/components/top-bar.tsx:421`). Two back buttons, 48px of height lost.
- Every region has a fixed size: left column `w-80`, timeline `max-h-[40%]`, transcript drawer `w-[500px]`. The user cannot adjust them.

## 2. Goals
- G1. Remove the view's own header bar. The `TopBar` back arrow is the only back control. The "Read-only history" badge moves into the left column, next to the "Task" label. **[assistant's call: badge placement]**
- G2. The left column (Task/Prompt) width is draggable via a vertical `ResizeHandle` between it and the right side.
- G3. The timeline/diff split is draggable via a horizontal `ResizeHandle` between them. The timeline keeps scrolling inside its own area.
- G4. The transcript drawer width is draggable via a vertical `ResizeHandle` on its left edge (dragging left widens it).
- G5. All three sizes persist in localStorage, are clamped to sane minimums/maximums, and reset with the existing "reset layout" action.

## 3. How (decided)
- Reuse the existing resize stack; no new dependency: `ResizeHandle` (`web-ui/src/resize/resize-handle.tsx`), `useResizeDrag` (`web-ui/src/resize/use-resize-drag.ts`), `ResizeNumberPreference` + `loadResizePreference`/`persistResizePreference` (`web-ui/src/resize/resize-preferences.ts`), `useLayoutResetEffect` (`web-ui/src/resize/layout-customizations.tsx`).
- One layout hook `web-ui/src/resize/use-done-task-history-layout.ts`, modelled on `use-git-history-layout.ts` / `use-card-detail-layout.ts`.
- Three new `LocalStorageKey` entries, also added to `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS` (`web-ui/src/storage/local-storage-store.ts`) so reset clears them.
- Defaults match today's look: left column 320px, timeline 40% of the right column height, transcript 500px. **[assistant's call: limits]** left column min 220px; timeline ratio 0.15–0.8; transcript min 360px, max 80% of the view width; the right side always keeps at least 400px.
- Drop the now-unused `onBack` prop from `DoneTaskDetailView` and its call site in `App.tsx`.

## 4. Non-goals
- No change to the `TopBar` itself.
- No change for the impeccable "cramped padding" warnings on diff rows: they count coloured diff rows (1px vertical padding), already recorded as a false positive in `2026-10-30-ui-contrast-and-history-polish-design.md` §3.
- The `localhost:3484` origin 403 (assets blocked when opened via `localhost` instead of `127.0.0.1`) is a separate issue, not in this change.

## 5. Verification
- `done-task-detail-view.test.tsx`: the view renders no "Back" button; "Read-only history" is still shown; `role="separator"` handles exist for the left column and the timeline/diff split, plus one on the transcript drawer when it is open.
- Unit test for the layout hook's clamp functions.
- `npm run typecheck`, `npm run web:typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:test`.
