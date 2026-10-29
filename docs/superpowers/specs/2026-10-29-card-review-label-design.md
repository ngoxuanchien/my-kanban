# Review state on the board card — design

Date: 2026-10-29
Status: approved by the user in chat (chose "add to the agent line")

## Problem

Cards show the agent and model (`web-ui/src/components/board-card.tsx:466`, `[agentOverrideLabel, modelOverrideLabel]` joined with ` · `) but nothing about agent review. The user cannot see on the board whether a task will be reviewed, which round it is in, or whether it was handed off.

## Design [user]

Extend the same line; no new element, no new styles.

`parts = [agentOverrideLabel, modelOverrideLabel, handoffLabel, reviewLabel]`, empty parts dropped, joined with ` · `.

- `handoffLabel`: `"Handed off"` when `card.handedOff === true`, else none.
- `reviewLabel`:
  - `card.agentReviewEnabled !== true` → none;
  - `reviewRound` 0 or missing → `"Review"`;
  - otherwise `` `Review ${reviewRound}/${handedOff ? 6 : 3}` ``.

Examples: `Codex · Review`, `Codex · Review 2/3`, `OpenCode · Handed off · Review 4/6`. A card with review on and no agent override shows `Review` alone.

Put the label logic in a small pure helper next to the card (for example `getCardReviewLabel(card)` in `web-ui/src/components/board-card.tsx` or a sibling util file) so it is unit-tested without rendering. **[assistant's call]**

## Non-goals
- Colours, icons, tooltips.
- Showing review state in the detail view.

## Tests
- Helper: review off → `null`; on, round 0 → `"Review"`; round 2 → `"Review 2/3"`; handed off round 4 → `"Review 4/6"`.
- `web-ui/src/components/board-card.test.tsx`: a card with agent codex, review on, round 2 renders `Codex · Review 2/3`; handed off opencode round 4 renders `OpenCode · Handed off · Review 4/6` (use the agent catalog labels as they really render).
