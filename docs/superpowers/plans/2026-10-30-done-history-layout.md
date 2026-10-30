# Plan: Done history single top bar and resizable panels

Spec: `docs/superpowers/specs/2026-10-30-done-history-layout-design.md`

One Kanban task.

## Task 1: drop the duplicate header, make the three regions resizable
Files: `web-ui/src/components/done-task-detail-view.tsx`, `web-ui/src/components/done-task-detail-view.test.tsx`, `web-ui/src/resize/use-done-task-history-layout.ts` (new), `web-ui/src/resize/use-done-task-history-layout.test.ts` (new), `web-ui/src/storage/local-storage-store.ts`, `web-ui/src/App.tsx`.
1. Tests first: in `done-task-detail-view.test.tsx` replace the Back-button test with "no Back button, Read-only history badge still shown"; add separator assertions (left column, timeline/diff, transcript drawer when open). Add clamp tests for the new hook.
2. Add three `LocalStorageKey` entries (left column width, timeline ratio, transcript width) and list them in `LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS`.
3. Write `useDoneTaskHistoryLayout` following `use-git-history-layout.ts`: preferences with defaults 320px / 0.4 / 500px, clamps per spec §3, `useLayoutResetEffect` reset, display values clamped to the measured container size.
4. In `done-task-detail-view.tsx`: remove the `<header>` and the `onBack` prop; move the badge next to the "Task" label; size the left aside, timeline and transcript drawer from the hook; add `ResizeHandle`s driven by `useResizeDrag` (x axis for left column and transcript, y axis for timeline). Remove `onBack` from the call in `App.tsx`.
5. Verify: typecheck, web:typecheck, lint, test:fast, web:test.
