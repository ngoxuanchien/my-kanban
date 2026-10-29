# Remove Agent Review

## Remove
- Remove the automatic reviewer service, reviewer UI and reviewer settings.
- Remove the `user_review` column so the board has Backlog, In Progress, Review and Done.
- Remove CLI support for `--agent-review-enabled` and the `user_review` column value.
- Remove reviewer-only runtime, terminal and tRPC plumbing.

## Keep
- Tasks that finish remain in Review for the user to review with the Kanban sidebar agent.
- Keep auto-commit and auto-PR behavior, settings and UI.
- Keep unrelated OpenCode, shutdown/resume and programmatic card-move fixes.
- Keep shared terminal behavior when it is used by non-reviewer sessions.

## Compatibility
- When loading a saved board, move cards from `user_review` into `review` and drop the old column.
- When loading cards with `agentReviewEnabled` or `agentReview`, ignore and drop those fields.
- Ignore `reviewerAgent` in existing global config, including the value `cross`.
- Future board saves use only the four supported columns and omit removed card fields.
