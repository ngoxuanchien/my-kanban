# Runtime moves cards between In Progress and Review

Date: 2026-11-04
Status: draft

## Why

Only the web UI moves a card to Review when its agent finishes a turn. With no board tab open (CLI only, sidebar only, desktop window closed), the card stays in In Progress though the agent is done, and later steps that read the column see the wrong state.

Idea taken from dsh-superagent (`docs/001-domain.md:35`, "a Ticket defines its own state instead of following the Executor's"; rejected concept "Ticket state that follows the DSH Session", `:56`): the board state must be kept by the runtime, not reconstructed by whichever client happens to be open.

## Current behavior (evidence)

- The UI moves `awaiting_review` cards In Progress → Review and `running` cards Review → In Progress (`web-ui/src/hooks/use-board-interactions.ts:446-480`).
- The runtime never moves a card to Review: in `src/`, `moveTaskToColumn` is called only for `in_progress` (`src/server/hand-off-task.ts:114`, `src/commands/task.ts:1333`) and `trash` / `backlog` (`src/core/task-board-mutations.ts:444`, `src/github/reverse-sync.ts:188-194`).
- Workarounds already exist for the gap: the sidebar checks both columns (`src/server/sidebar-review-service.ts:352`) and `task done --review-passed` accepts a task still in In Progress (`src/core/task-board-mutations.ts:217`; spec `2026-11-03-dependency-start-after-review-pass-design.md`).
- Per-workspace runtime services subscribe to session summaries through `terminalManager.onSummary` and `clineService.onSummary` (`src/server/sidebar-review-service.ts:605`), created per workspace in `src/server/runtime-server.ts:190-215` (`ensureSidebarReviewService`).
- Board writes are revision-checked (`src/state/workspace-state.ts`, `web-ui/src/runtime/use-workspace-persistence.ts`); the UI hydrates from a newer revision.

## Goal

The runtime moves a card:
- In Progress → Review when its session becomes `awaiting_review` (a permission wait no longer becomes `awaiting_review`, per `2026-11-04-permission-wait-design.md`).
- Review → In Progress when its session becomes `running`.

The move happens whether or not a UI is connected. The UI shows the result.

## Non-goals

- The `interrupted` → trash move in the UI (`use-board-interactions.ts:481-506`) stays as it is.
- Auto-commit / auto-PR (`web-ui/src/hooks/use-review-auto-actions.ts`) still runs in the UI; moving it to the runtime is a separate change.
- Home (sidebar) agent sessions are never moved (`isHomeAgentSessionId`).

## Anti-goals

- No lost board writes: a runtime move must not overwrite an edit the UI is saving, and a UI save must not undo a runtime move (upstream #674, `contexte/upstream-issues.md`).
- No move loops between the UI and the runtime.

## Design

1. A small per-workspace listener, created next to the sidebar review service in `src/server/runtime-server.ts`, subscribes to `terminalManager.onSummary` and `clineService.onSummary`.
2. It acts on **state transitions only** (previous summary `state` differs from the new one), never on activity-only updates, so a manual drag is not fought while a session runs. When the listener starts, one reconcile pass moves In Progress cards whose summary is already `awaiting_review`. On a transition it calls `mutateWorkspaceState`: if the card is in `in_progress` and the state is `awaiting_review`, move it to `review` at the top; if it is in `review` and the state is `running`, move it to `in_progress` at the top. Otherwise no write. After a saved move, run the same side effects as a UI save (`deps.onWorkspaceStateChanged` and `broadcastRuntimeProjectsUpdated`, `src/trpc/workspace-api.ts:486-488`), so GitHub issue sync posts the column change, then broadcast the workspace state.
2b. This listener is the only place that moves cards between these two columns, for both terminal and Cline sessions. The hooks API and `runtime-state-hub.ts:536` keep their current behavior.
3. The move uses the shared `moveTaskToColumn` from `src/core/task-board-mutations.ts`.
4. The UI drops its two auto-move branches (`use-board-interactions.ts:457-480`) and follows the runtime board. The card animation for these two moves is lost; acceptable.
5. The sidebar review service must still see the card in Review when it handles the same summary. The builder orders the two listeners or makes the review service tolerate either column (it already reads both in `checkStuckTasks`).

## Acceptance

- Runtime test with no UI client: a session going `running` → `awaiting_review` moves the card from In Progress to Review in saved state; `awaiting_review` → `running` moves it back.
- A permission wait (session stays `running`) does not move the card.
- A card in Backlog, Done, or Trash is never moved.
- Concurrency test: a UI save with a stale revision after a runtime move is rejected and does not undo the move (current refetch + "Retry your last edit" toast, `web-ui/src/runtime/use-workspace-persistence.ts:127-140`, is accepted; no merge).
- An activity-only summary update on a running card the owner dragged to Review does not move it back.
- A runtime move triggers `onWorkspaceStateChanged` once.
- Web-ui test: with the auto-move branches removed, a board update from the runtime renders the card in the new column.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck` pass.

## Left to the builder

- File name and shape of the listener.
- How to keep the UI from writing back a stale column (the revision check may already cover it; prove it with the concurrency test).

## Calls made by the planner (not confirmed by the owner)

- Lose the UI card animation for these two moves rather than keep two writers.
- Keep `interrupted` → trash and auto-commit in the UI for now.
- On a save conflict, keep today's reject + refetch + toast; no merge logic.
- Move on state transitions plus one reconcile pass at start, not on every summary.
- Runtime moves run the same save side effects as a UI save (GitHub issue sync follows).
- Keep the existing workarounds (sidebar reads both columns; `--review-passed` from In Progress).
- Lands after the permission-wait change, so permission waits are not moved to Review by the runtime.
