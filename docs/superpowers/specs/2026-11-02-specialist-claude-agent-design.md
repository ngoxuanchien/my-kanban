# Specialist Claude agent per task — design

Date: 2026-11-02
Status: written after the user skipped the questions ("bỏ qua câu hỏi, bắt đầu làm luôn đi")
Builds on: `2026-11-01-claude-model-per-task-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Why

The user has Claude Code subagents of their own in `~/.claude/agents/` (today `debugger`, `database-admin`; also the read-only helpers `graph-explorer`, `kanban-task-writer`). They want these agents to take part in Kanban work: tasks that need a specialty run on the matching specialist instead of a general agent. **[user]**

Today a `claude` task always starts a plain Claude Code session. Claude Code can start a session *as* a given agent with `claude --agent <name>`: the agent's system prompt, tools and model become the session's (verified 2026-11-02 with Claude Code's CLI; an unknown name exits with `--agent '<name>' not found. Available agents: ...`, and plugin agents such as `ecc:typescript-reviewer` are accepted).

## 2. Goals, non-goals, anti-goals

### Goals
- G1. A task whose agent is `claude` can carry a specialist agent name (`claudeAgent`). Its session starts with `claude --agent <name>`. **[user]**
- G2. The sidebar can set it from the CLI: `task create` / `task update --claude-agent <name>`; `task update --claude-agent default` clears it. **[assistant's call]** (mirrors `--model`)
- G3. The sidebar routes specialist work on its own: when a task is mainly the specialty described by one of the user's own Claude agents that can edit files, it creates the task with `--agent-id claude --claude-agent <name>`. Other tasks keep the codex → opencode → antigravity rotation. **[user]** ("task chuyên biệt cho các agent có tính năng này")
- G4. The card shows the specialist so the user can see who works on it. **[assistant's call]**
- G5. The score strip scores a specialist task under the specialist's name (e.g. `debugger`), not under the model, so the user can see how each specialist performs. **[assistant's call]**

### Non-goals
- A UI picker for the specialist. Choosing is done from the sidebar/CLI; the UI only shows it and must keep it on save. **[assistant's call]** (listing agents needs a runtime scan of `~/.claude/agents`, project and plugin agents; easy follow-up)
- Specialists for codex / opencode / antigravity. They do not read `~/.claude/agents`. **[assistant's call]**
- Validating the name in Kanban. Claude Code already fails loudly on an unknown name (§1); the task then shows the error in its terminal. **[assistant's call]**
- Changing the handoff cycle. `claude` is not in `HAND_OFF_CYCLE` (`src/core/hand-off-cap.ts:3`); a specialist task that hits its review cap follows today's rule for a failed handoff (`task review-failed`, task stays in Review). **[assistant's call]**
- Specialists for the home/sidebar session.

### Anti-goals
- The sidebar sending general implementation work to Claude through a specialist. Routing only fires on a clear specialty match (§4).
- A score recorded under a specialist that did not run (card edited after the session started).
- A UI board save dropping `claudeAgent` (see `AGENTS.md`, board-state rebuild sites).
- Breaking custom Claude launch args: if they already contain `--agent`, Kanban adds no second one.

## 3. Data

- Card: new optional field `claudeAgent: string` on `runtimeBoardCardSchema` (`src/core/api-contract.ts:~203`, next to `claudeModel`). Schema: non-empty, max 256 chars, `^[A-Za-z0-9][A-Za-z0-9_.:-]*$` (allows plugin names like `ecc:debugger`, rejects spaces and leading `-` so it can never be read as a flag). **[assistant's call]**
- Kept when the agent changes away from `claude` and back, ignored for other agents (same as `claudeModel`). **[assistant's call]**
- `claudeModel` is unchanged and still passed as `--model` (card value or `claudeDefaultModel`). A specialist's own `model:` frontmatter therefore does not override the task's model. **[assistant's call]** Keeps one source of truth for the model the user already controls.
- Session summary: new optional `claudeAgent: string | null` next to `claudeModel` (`src/core/api-contract.ts:~361`, `src/terminal/session-manager.ts:~354`), = the `--agent` value actually in the launch args, else `null`.

## 4. CLI and sidebar

- `task create` / `task update` accept `--claude-agent <name>`; `default` on update clears it. Invalid name → clear error. On a task whose effective agent is not `claude` → error, same rule as `--model` (`src/commands/task.ts`). **[assistant's call]**
- `task list` shows `claudeAgent` when set.
- Sidebar system prompt (`src/prompts/append-system-prompt.ts`): document the flag in the `task create` / `task update` references, and replace the rule at `:338` so that:
  - Specialists = the user's own Claude Code agents (user-level, `~/.claude/agents/`) whose tools include Edit or Write. The sidebar reads them from its own Agent tool list; nothing is hard-coded. Plugin agents (`ecc:*`, …) only when the user names one. **[assistant's call]**
  - When a task is mainly the specialty in one specialist's description (e.g. finding the root cause of a bug → `debugger`; schema, query, index, migration work → `database-admin`), create it with `--agent-id claude --claude-agent <name>`. Otherwise keep the codex → opencode → antigravity rotation. Do not pass `--model` unless the user names one.
  - The task prompt for a specialist must say explicitly that the agent must implement the change and run the acceptance commands, because specialists such as `debugger` default to report-only.
  - Tell the user in one line when a task was routed to a specialist, and why.

## 5. Session start

- `claudeAdapter.prepare` (`src/terminal/agent-session-adapters.ts:~435`) appends `--agent <name>` when `input.claudeAgent` is set, the session is not a home session (`isHomeAgentSessionId`), and `hasCliOption(args, "--agent")` is false. Resumes (`--continue`) pass it too. **[assistant's call]**
- Plumbing: the same path `claudeModel` takes from the card to the adapter (`src/trpc/runtime-api.ts:~424-438`, `src/terminal/session-manager.ts:98,340`). **[builder]** exact shape.

## 6. Scoring

- `resolveScoreAgentKey` (`src/core/claude-model.ts:18`) gains a specialist input: for a `claude` task, if the session's recorded `claudeAgent` is set, the key is that name; else if no session is recorded and the card has `claudeAgent`, the card's name; else today's model logic. Every caller passes the new fields (`src/trpc/runtime-api.ts:~164-177`, `:~584`, `src/commands/task.ts`). **[assistant's call]**
- The strip prints the key as-is; no UI change.

## 7. UI

- Card agent line (`web-ui/src/components/board-card.tsx:~444`): for a `claude` card with `claudeAgent`, show `Claude · <name>`. **[assistant's call]**
- Thread `claudeAgent` through `web-ui/src/types/board.ts` and every card rebuild in `web-ui/src/state/board-state.ts` listed in `AGENTS.md` (`normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, `disableTaskAutoReview`), with a web-ui test per path, as `claudeModel` did.

## 8. Tests (acceptance)

- Adapter: `--agent debugger` added for a task card with `claudeAgent: "debugger"`; absent when unset; no duplicate when args already contain `--agent`; none for a home session; present on resume.
- Session summary records `claudeAgent` from the launch args.
- CLI: `task create --agent-id claude --claude-agent debugger` stores it; `task update --claude-agent default` clears it; `--claude-agent` with `--agent-id codex` fails; `--claude-agent "-x"` and `"a b"` fail.
- Scores: a pass on a task whose session ran `--agent debugger` scores `debugger`; editing the card to `database-admin` after start still scores `debugger`; a `claude` task without specialist still scores its model.
- Sidebar prompt test: the prompt documents `--claude-agent` and the routing rule.
- web-ui: card shows `Claude · debugger`; each board-state rebuild path keeps `claudeAgent`.
- `npm run typecheck`, `npm run lint`, `npm run test:fast` pass.

## 9. Left to the builder

- Exact plumbing types between runtime-api, session-manager and the adapter.
- Whether the name schema lives in `src/core/claude-model.ts` or a sibling `src/core/claude-agent.ts`.

## 10. Risk the user should know

- Specialist tasks run on Claude and use the same quota the sidebar reviewer needs. The 2026-11-01 spec kept Claude out of the rotation for this reason; routing here is limited to clear specialty matches.
