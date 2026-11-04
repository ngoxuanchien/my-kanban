# "Needs you" label and ordering on the board

Date: 2026-11-04
Status: draft

## Why

The Review column mixes tasks the sidebar reviewer will handle on its own with tasks only the owner can move forward. The owner has to open cards to tell them apart.

Idea taken from dsh-superagent (`docs/005-panel.md:52-57`, "a panel that shows only what needs a person"; `docs/003-execution.md:9-17`, stages named by whom they wait for). Kanban keeps its columns; it only adds who-is-it-waiting-on to the card and puts owner-waiting cards first.

Builds on `2026-11-04-permission-wait-design.md` (permission waits stay in In Progress with "Waiting for approval") and extends `2026-10-29-card-review-label-design.md` (the `Review n/cap` label).

## Current behavior (evidence)

- The card agent line already shows review state: `Review n/cap`, `Handed off`, `Out of quota` (`web-ui/src/components/board-card.tsx:498-513`, `getCardReviewLabel` at `:57`).
- `task review-failed` only records a score; it sets no card field (`src/commands/task.ts:1587-1604`).
- Review cap is `3 × (handOffCount + 1)` and handoffs stop at `MAX_HAND_OFFS = 2` (`src/core/hand-off-cap.ts:5`, `:29-31`).
- Column order is the stored card order; cards moved to Review are inserted at the top (`web-ui/src/hooks/use-board-interactions.ts:462`).

## Goal

Every card in Review shows exactly one of two labels, and cards labeled "Needs you" are listed before the others. In In Progress, cards waiting for approval are listed first.

## Rules (one pure function)

Principle: **"Sidebar" only when the runtime or sidebar is known to act on the card next; everything else is "Needs you".** A wrong "Needs you" costs one look; a wrong "Sidebar" hides a stuck task.

For a card in **Review** with `agentReviewEnabled === true`, the label is **Sidebar** when one of these holds, otherwise **Needs you**:

| Sidebar when | Why the runtime acts (evidence) |
|---|---|
| `quotaBlockedAt` is set | hourly quota retry (`src/server/sidebar-review-service.ts:142-198`) |
| summary is `awaiting_review` with `reviewReason` `hook`, or `exit` with code 0, and `reviewRound < getReviewRoundCap(card)` | finished turn queued for review (`:529-531`, `:443`) |
| summary is `awaiting_review` with `reviewReason` `hook` / `exit` 0, `reviewRound >= cap`, and `getHandOffCount(card) < MAX_HAND_OFFS` with agent in `HAND_OFF_CYCLE` | sidebar hands it off at the cap |
| summary is `failed`, or `reviewReason` `error`, or `exit` non-zero, **and** `summary.agentId` equals `card.agentId` **and** the card can still hand off | crash handoff (`:525-560`; agent mismatch returns early at `:539-541`) |

So these are **Needs you**: review off; no summary (e.g. after an app restart); `idle`; `interrupted`; a crash with an agent mismatch or no handoff left; the cap reached with no handoff left.

The function takes `summary: RuntimeTaskSessionSummary | undefined`.

For a card in **In Progress**: "first" when the session `latestHookActivity.activityText === "Waiting for approval"`; no new label (the activity line already says it).

Backlog and Done: unchanged.

## Design

1. A pure function `getCardAttention(card, summary): "owner" | "sidebar" | null` in `web-ui/src/` next to `getCardReviewLabel`, reusing `getHandOffCount`, `getReviewRoundCap`, `MAX_HAND_OFFS`, `isHandOffAgentId` from `src/core/hand-off-cap.ts`.
2. The card agent line appends `Needs you` (status-orange) or `Sidebar` (text-tertiary) in Review only.
3. Ordering is display-only: a stable sort when rendering Review (owner first) and In Progress (approval wait first). Stored order does not change.

## Non-goals

- No new column, panel, filter, or count badge.
- No new card field; everything is derived from existing card and session fields.
- No runtime change.

## Anti-goals

- Drag and drop must keep working: dropping a card must land where the owner sees it drop, not at the index it has in stored order.
- A card must never show "Sidebar" when the sidebar will not touch it again.

## Acceptance

- Unit tests for `getCardAttention`: one per "Sidebar" row, and one per "Needs you" case listed under the table (review off, no summary, idle, interrupted, crash with agent mismatch, crash with no handoff left, cap with no handoff left).
- Component test: Review renders owner cards first, keeping relative order inside each group; In Progress renders an approval-wait card first.
- Drag test: reordering inside a sorted Review column moves the dragged card to the shown drop position.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck` pass.

## Left to the builder

- How display sorting maps to `Draggable` indices (sort before render and translate the drop index back to stored order, or persist a reorder on drop).
- Exact file names.

## Calls made by the planner (not confirmed by the owner)

- UI labels are English like the rest of the app: `Needs you`, `Sidebar`.
- Quota-blocked cards count as "Sidebar" because the runtime retries them on its own.
- A crash that can still hand off counts as "Sidebar" only when the runtime crash path would act (agent ids match, not `interrupted`).
- Whether the sidebar session itself is alive is not modeled; if it is stopped, "Sidebar" cards wait until it runs again. Add a home-session input only if this bites.
- Lands after the permission-wait change; until then permission waits would show in Review.
