# Superseded by 2026-10-29-remove-agent-review-design.md

# Agent review live terminal — plan

Spec: `docs/superpowers/specs/2026-10-28-agent-review-live-terminal-design.md`.

1. `src/terminal/session-manager.ts`: `disableAutoRestart` on `StartTaskSessionRequest`.
   → verify: session-manager test for no auto-restart.
2. `src/trpc/hooks-api.ts`: no checkpoint / ready-for-review broadcast for `agent-review:` keys.
3. `src/agent-review/reviewer-output.ts`: `parseReviewerVerdict(content | null)`; `reviewer-prompt.ts`:
   verdict-file instructions. Delete `claude-stream-json.ts`.
   → verify: reviewer-output / reviewer-prompt tests.
4. `src/agent-review/reviewer-runner.ts`: PTY run through `TerminalSessionManager` (start, attach, poll
   verdict, turn end, exit, timeout, cancel, wait for exit); Cline run reads the verdict file.
   → verify: reviewer-runner tests with a fake terminal manager.
5. `src/agent-review/agent-review-service.ts`, `reviewer-log.ts`, `src/core/api-contract.ts`: temp verdict
   dir per run, run metadata only (no output).
   → verify: agent-review-service tests.
6. web-ui: `ReviewerTerminalPanel` renders `AgentTerminalPanel` for `agent-review:<taskId>`; pass
   workspace id and the reviewer session summary through `AgentReviewerTabs`.
   → verify: agent-reviewer-tabs test, web-ui typecheck.
7. Full `npm run check` / typecheck / tests; manual run with a reviewed task.
