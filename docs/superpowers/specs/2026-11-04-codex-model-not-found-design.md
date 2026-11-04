# Detect Codex `model_not_found` and hand off at once

Date: 2026-11-04

## Why

On 2026-11-04 two Codex tasks (3a390, e48df) sat idle for minutes: every Codex turn failed with
`The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.` because the owner's
`~/.codex/config.toml` named a model the account may not use. Kanban saw no usage-limit phrase, so it only sent
`continue` after 5 minutes (`QUOTA_NUDGE_WAIT_MS`, `src/server/sidebar-review-service.ts:51`) and waited again.
The sidebar misread it as a quota problem. The error is recorded in Codex's rollout file as structured data:
an `event_msg` line whose `payload.type` is `task_complete` and `payload.error.codex_error_info` is `"model_not_found"`.

## Goal

When a Codex task session's latest rollout turn ended with `codex_error_info: "model_not_found"`, treat the task as stuck
with a clear cause, the same way a clear OpenCode log quota phrase is treated today: hand off at once, without sending
`continue` first. Record a task comment telling the owner to change the model in Codex's config (or the task's model).

## Non-goals

- No automatic edit of `~/.codex/config.toml`.
- No relaunch of Codex with another model (that belongs to the difficulty-model feature).
- No other Codex error codes in this change.

## Decided

- New reader next to `src/server/opencode-log-usage-limit.ts`: find Codex rollout files under `~/.codex/sessions/YYYY/MM/DD/`
  (honour `CODEX_HOME` if set) modified since the session started, whose first `session_meta` line has `payload.cwd`
  equal to the task worktree path; read the newest one's tail and return `"model_not_found"` when its last
  `task_complete` has that `codex_error_info`. Bounded read (tail, like the OpenCode reader's 2 MiB cap).
- Wire it into the stuck-task check in `sidebar-review-service.ts` for `agentId === "codex"` beside the OpenCode/Antigravity
  log checks (`:83-122`), as a clear cause → immediate handoff path (no `continue`). When no handoff is left, use the
  existing "Out of quota" label + hourly retry path (a retry succeeds once the owner fixes the config).
- Handoff reason and task comment must NOT quote the Codex error text or any `USAGE_LIMIT_PHRASES` entry (lesson from
  `docs/superpowers/specs/2026-10-30-handoff-reason-self-trigger-design.md`). Reason text, verbatim:
  `Codex cannot use its configured model (model_not_found).` Comment adds: `Change "model" in ~/.codex/config.toml to one your account supports.`
- Reading failures are logged with `deps.warn` and never break the check.

## Acceptance

- Unit tests for the reader with fixture rollouts: matching cwd + `model_not_found` → detected; other cwd → null;
  older than session start → null; last turn succeeded after an earlier error → null; malformed lines skipped.
- Service test: codex task, reader returns `model_not_found` → handoff called at once with the exact reason, no `continue`
  sent, comment recorded; no handoff left → quota-blocked path.
- No test reads the real `~/.codex`.
- `npm run typecheck`, `cd web-ui && npm run typecheck`, `npm run lint`, `npm run test:fast` pass.
