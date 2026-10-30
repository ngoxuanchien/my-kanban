# Agent score moves to a bottom status bar

Date: 2026-10-30
Status: approved (user, 2026-10-30)
Builds on: `2026-10-29-agent-scoreboard-design.md`

## 1. Problem
The agent score strip (`codex +6 (13 tasks) · opencode +1 (2 tasks) · …`) sits on the right of the top bar (`web-ui/src/components/top-bar.tsx:524-558`). It takes most of the bar's width and makes the top bar feel crowded. **[user]**

## 2. Goal
- G1. Remove the score strip from the top bar. **[user]**
- G2. Show the same strip, same content, colours and tooltip, in a slim status bar at the bottom of the main column (the `flex flex-col flex-1` column that holds the top bar, in `web-ui/src/App.tsx` around line 840), so it sits under the board and under the task detail view. **[user: bottom of the screen; assistant's call: main column, not under the project sidebar]**
- G3. Bar style: `h-6` (24px), `border-t border-border bg-surface-1`, `px-3 text-xs`, items left-aligned, `shrink-0`. Hidden when there are no scores, same as today. Hidden below the `md` breakpoint, same as today. **[assistant's call]**

## 3. Non-goals
- Changing how scores are computed or streamed (`agentScores` from workspace state).
- Showing the bar in the project sidebar.

## 4. Design
- New component `web-ui/src/components/agent-score-bar.tsx` that renders the strip moved from `top-bar.tsx` (keep `data-testid="agent-score-strip"`, the `Tooltip`, the `+N` / `−N` / `0` formatting and the `task`/`tasks` plural).
- `TopBar` drops the `agentScores` prop and the strip.
- `App.tsx` renders `<AgentScoreBar agentScores={streamedWorkspaceState?.agentScores} />` as the last child of the main column.
- Tests move from `top-bar.test.tsx:141-190` to `agent-score-bar.test.tsx`; `top-bar.test.tsx` asserts the strip is no longer in the top bar.
