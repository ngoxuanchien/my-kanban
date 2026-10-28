# Agent review: live reviewer terminal — design

Status: accepted. Builds on `2026-10-28-agent-review-design.md` (4.3, 4.7).

## Problem

The reviewer ran one-shot (`claude -p --output-format stream-json`, `codex exec`, `opencode run`) and the
Reviewer tab rendered parsed lines read-only. The user wants to watch the reviewer's real TUI live, the
same way the Task agent tab shows the task agent.

## Decisions

1. **Same PTY machinery as task agents.** A reviewer run is a `TerminalSessionManager.startTaskSession`
   session under the key `agent-review:<taskId>` in the task's workspace manager. The launch goes through
   `prepareAgentLaunch` (same adapters, hooks, workspace-trust handling) and launches the agent binary
   directly (no shell). The browser attaches with the normal `AgentTerminalPanel` / terminal websocket,
   using the reviewer key as `taskId`. Its summary flows through the normal session broadcast, so the
   terminal resets on a new run exactly like a restarted task session.
2. **Verdict file.** The reviewer prompt names a JSON file in a fresh temp dir (outside the worktree, so
   the "reviewer modified the worktree" check is unaffected). The reviewer writes the same JSON object it
   used to print between markers, with a shell command (file-edit tools stay disabled). The runtime reads
   it; the marker parser and the Claude stream-json parser are deleted.
3. **Non-interactive end.** Interactive TUIs do not exit. The runtime ends the session when:
   - the verdict file holds a valid result (polled every second), or
   - the reviewer's turn ends (hook-driven `classifyTurnEnd === "turn_end"`), with or without a valid file, or
   - the process exits on its own, or
   - the run times out (20 min) or is cancelled (user input, card moved/deleted/toggled off, dispose).

   A permission/attention stop (`needs_user`) is left running: the user can answer it in the live
   terminal; the timeout still bounds it. `done` resolves only after the PTY has exited (5 s grace), so the
   next run under the same key never finds the previous process still alive.
4. **Outcomes.** Missing file → `bad_output` ("reviewer did not write the verdict file"), or `crashed` if
   the process exited non-zero. Malformed JSON / wrong shape → `bad_output`. Timeout → `timeout`.
   Cancelled → dropped (the existing stale-run guards apply). All of them already route to
   Needs your review, so a card is never left in `reviewing`.
5. **Reviewer sessions are runtime-owned.** `StartTaskSessionRequest.disableAutoRestart` keeps an
   attached browser from relaunching a reviewer that exited. `suppressAlternateScreen` drops the
   TUI's alternate-screen switches (`?47`/`?1047`/`?1049`), so Claude Code et al. draw on the main
   screen and their last frame survives the exit (otherwise the restore after Done is empty). Hook ingest skips turn checkpoints and the
   ready-for-review notification for `agent-review:` keys. Board/UI code ignores the key because no card
   has that id.
6. **Per-agent launch args** (prompt is added by the adapter; autonomous mode is always on for reviewers):
   - claude: `--strict-mcp-config --mcp-config {"mcpServers":{}} --allowedTools Bash,Read,Grep,Glob
     --disallowedTools Edit,Write,NotebookEdit --add-dir <verdictDir>`
   - codex: none beyond the adapter's (`--dangerously-bypass-approvals-and-sandbox`).
   - opencode: none; `OPENCODE_CONFIG_CONTENT` still denies `edit` and `question`.
   - droid, kiro: catalog base args only.
   - cline: unchanged in-process SDK session (no PTY); it reads the same verdict file. Its Reviewer tab
     says that there is no terminal output.
7. **Reviewer tab.** Header keeps agent, round label, elapsed time. Body is the live terminal; after Done
   the session's terminal mirror (screen + scrollback) is restored on attach, in memory only (as before).
   `getAgentReviewLog` keeps returning run metadata (`reviewerAgentId`, `round`, `startedAt`,
   `finishedAt`); `output`/`truncated` are removed.

## Out of scope

Persisting reviewer scrollback across a Kanban restart (it was not persisted before either).
