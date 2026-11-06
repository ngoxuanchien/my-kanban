# Handoff fail score uses the session model

One Kanban task, no separate plan.

## Problem

When a review-enabled task is handed off, `src/trpc/app-router.ts:608` records the fail score with `resolveScoreAgentKey({ agentId: result.fromAgentId })`, without the model that session ran. The fail lands on plain `codex` / `opencode`, while assignments, `task send` fails and pass/fail from `task done` (`src/commands/task.ts:460`) use `codex:<model>`. One agent + model's history is split across two score keys. Known gap since `contexte/difficulty-model-selection.md`; it was fixed on 2026-11-06 (9755d8fe) and lost when that feature was reverted (330ba9b7).

## Change

- In the `handOffTask` mutation (`src/trpc/app-router.ts` ~585-615), read the task's session model before calling `ctx.runtimeApi.handOffTask` (the handoff replaces the session): `loadWorkspaceState(ctx.workspaceScope.workspacePath).sessions[input.taskId]?.agentModel ?? null` (session summary field `agentModel`, `src/core/api-contract.ts` ~382). Persisted `sessions.json` carries `agentModel` for codex sessions (checked on 2026-11-06).
- Pass it as `sessionAgentModel` to `resolveScoreAgentKey` for the fail event.
- A failed state read keeps today's behavior (plain key) and only warns, inside the existing try/catch.

## Non-goals

- Any change to the handoff itself, the response contract, or `runtime-api.ts`.

## Files

- `src/trpc/app-router.ts`
- `test/runtime/agent-score-recording.test.ts`

## Acceptance

- Test: handoff fail with session model `gpt-5` records `codex:gpt-5`; with no session record it records `codex`.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck`, `npm --prefix web-ui run test`, `npm run web:build` pass.
