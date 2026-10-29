# Sidebar agent review — design spec

Date: 2026-10-29
Status: approved by the user 2026-10-29
Depends on: Kanban task `d3bbd` (removes the old agent-review feature and the `user_review` column). Build this on top of that change.

## 1. Intent

The user wants the Kanban sidebar agent (the home agent chat, usually Claude Code) to act as the reviewer. When a task with review turned on finishes, the sidebar agent reviews it, sends up to 3 rounds of fix instructions to the task agent, and then either commits it and moves it to Done, or reports it to the user in the sidebar chat. **[user]**

Why: one place to talk to (the sidebar chat), no separate reviewer process or extra column, and the review history stays readable in the chat. **[user]**

## 2. Goals, non-goals, anti-goals

### Goals
- G1. A CLI command `task send` that delivers a message to a running task agent session, as if typed into its terminal. **[user]**
- G2. Per-task opt-in: a task with review **on** is reviewed by the sidebar agent. A task with review **off** stays in Review for the user to review by hand, exactly like upstream Kanban. **[user]**
- G3. Never interrupt the user: the runtime only wakes the sidebar agent when its current turn has ended. **[user]**
- G4. Review loop: pass → sidebar agent commits and moves the task to Done. Fail → fix message via `task send`, at most 3 review rounds. Still failing after round 3 → report to the user in the chat and leave the task in Review. **[user]**

### Non-goals
- No separate reviewer process, reviewer setting, cross review or extra board column (all removed by `d3bbd`).
- No PR mode. Pass means a local commit onto the task's base ref, never a push. **[user git policy]**

### Anti-goals (failure even if it "works")
- The runtime types into the sidebar while the user is mid-conversation or while the sidebar agent is still working.
- A review-off task is touched by the sidebar agent.
- A task loops forever between Review and In Progress.

## 3. What exists (grounding)
- The sidebar chat is a normal terminal session with a synthetic task id `__home_agent__:<workspaceId>:<agentId>` (`src/core/home-agent-session.ts`). It is managed by `TerminalSessionManager` like task sessions.
- Turn end is already known per session from agent hooks (`src/trpc/hooks-api.ts`); that is what moves a task card to Review.
- Before `d3bbd`, `src/agent-review/send-prompt-to-task.ts` (commit 9875de30) wrote a prompt into a task PTY and submitted it. Its approach can be reused for G1 and for waking the sidebar; check `git show 9875de30` for how submission works, and 33669791 for the OpenCode v2 gotcha where prompt text was run as a shell command.
- The sidebar agent's instructions live in `src/prompts/append-system-prompt.ts`. They currently say "NEVER edit, create, delete, or modify any files" (`:140`, `:158`).
- The default commit steps (commit in the task worktree, cherry-pick onto `{{base_ref}}` where it is checked out, stash handling) are `DEFAULT_COMMIT_PROMPT_TEMPLATE` in `src/config/runtime-config.ts:69`.

## 4. Design

### 4.1 `task send` (G1)
`kanban task send --task-id <id> --message "<text>" [--project-path <path>]`.
- Works only when the task has a live agent session; otherwise it fails with a clear JSON error. It is allowed while the task is In Progress too (same as the user typing into its terminal).
- If the task card is in Review, sending a message moves it back to In Progress (the agent is working again). The next turn end moves it to Review again as usual.
- Exposed through the runtime tRPC API like the other `task` commands, and listed in the sidebar CLI reference in `append-system-prompt.ts`.

### 4.2 Per-task review flag (G2)
- Task field `agentReviewEnabled: boolean`, default `false`. CLI `task create|update --agent-review-enabled <true|false>`. A toggle in the task create dialog / inline create card. **[assistant's call: reuse the old name so the familiar CLI flag keeps working]**
- Old values dropped by `d3bbd`'s migration are not restored.
- When `agentReviewEnabled` is on, the upstream auto-commit / auto-PR action must not fire for that task (the sidebar agent commits after a pass). The UI disables the auto-review controls while agent review is on. **[assistant's call]**
- `task list` output includes, per task, `agentReviewEnabled`, `reviewRound`, `baseRef` and the task worktree path, so the sidebar agent needs no guessing. **[assistant's call]**

### 4.3 Review queue and wake-up (G3)
- When a task with `agentReviewEnabled` enters Review, the runtime increments the task's `reviewRound` (stored on the card; reset to 0 when the task goes to Done or review is turned off) and adds it to a per-workspace queue.
- If `reviewRound` would exceed 3, the task is not queued; it waits for the user. **[assistant's call]**
- The runtime sends the next queued item into the workspace's sidebar session only when that session is alive and its last turn has ended (idle). One task per wake-up message. **[assistant's call]**
- If no sidebar session is running, the queue waits until one starts and becomes idle.
- Wake-up message (one line):
  `[Kanban review] Task <id> "<title>" is in Review, round <n>/3. Review it now.`
- Queue state may live in memory; after a runtime restart, tasks already in Review with review on and `reviewRound` ≤ 3 are re-queued. **[assistant's call]**

### 4.4 What the sidebar agent does (G4)
Instructions added to `append-system-prompt.ts` (a "Reviewing tasks" section):
1. On a `[Kanban review]` message: read the task prompt (`task list`), the worktree diff against the base ref (including untracked files), and run the acceptance commands from the prompt (default: `npm run typecheck`, `npm run lint`, `npm run test:fast`).
2. Pass → commit with the steps of `DEFAULT_COMMIT_PROMPT_TEMPLATE` (commit in the worktree, cherry-pick onto the base ref, preserve the user's uncommitted changes), then `task done --task-id <id>`. Report one line in the chat: task, commit hash, checks run.
3. Fail and round < 3 → `task send` a concrete fix list (file:line, failing command output). Report one line in the chat.
4. Fail and round = 3 → do not send; report to the user in the chat with the reasons and leave the task in Review.
- The "never modify files" rule gets one exception: git commit / cherry-pick / stash for a passed review. Still no code edits. **[assistant's call]**

## 5. Risks
- Token cost: every review is a Claude turn with tool calls on the user's Claude Pro plan. Accepted by the user by choosing this design.
- Typing into a PTY can race with the user typing in the sidebar terminal; the idle check reduces but does not remove this.
- Cherry-pick conflicts on the base ref: the sidebar agent resolves them per the commit template or reports to the user.

## 6. Left to the builder
- Exact idle detection for the sidebar session (hook state vs. session summary state).
- Where the queue lives (a small service next to the hooks ingest is expected).
- Exact tRPC route names and JSON shapes, following existing `task` commands.
- Test layout, following existing runtime and web-ui tests.
