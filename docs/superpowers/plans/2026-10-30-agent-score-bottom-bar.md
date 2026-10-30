# Plan: agent score bottom status bar

Spec: `docs/superpowers/specs/2026-10-30-agent-score-bottom-bar-design.md`

One Kanban task.

## Task 1: move the score strip to a bottom bar
Files: `web-ui/src/components/agent-score-bar.tsx` (new), `web-ui/src/components/agent-score-bar.test.tsx` (new), `web-ui/src/components/top-bar.tsx`, `web-ui/src/components/top-bar.test.tsx`, `web-ui/src/App.tsx`.
1. Move the score tests to `agent-score-bar.test.tsx` (fail first), then extract the strip into `AgentScoreBar`.
2. Remove the strip and the `agentScores` prop from `TopBar`; add a test that the top bar no longer renders `agent-score-strip`.
3. Render `AgentScoreBar` as the last child of the main column in `App.tsx`.
4. Verify: typecheck, web:typecheck, lint, test:fast, web:test.
