# Specialist Claude Agent Per Task Implementation Plan

> **For agentic workers:** each task below is one Kanban task, run in its own worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `claude` task can run as one of the user's Claude Code agents (`claude --agent <name>`), set via `--claude-agent` in the CLI, shown on the card, and scored under the agent's name; the sidebar routes clear specialty tasks to it.

**Architecture:** A name schema and helpers live in `src/core/claude-agent.ts`. The card stores `claudeAgent`. When a task session starts, the name goes to the Claude adapter, which appends `--agent <name>`; the session summary records the `--agent` value actually launched. `resolveScoreAgentKey` returns that name for specialist sessions. Mirrors `claudeModel` (commits 9b5fc690, dcc0a153, 7e25632a).

**Tech Stack:** TypeScript, zod, commander (CLI), vitest, React + Tailwind (web-ui).

**Spec:** `docs/superpowers/specs/2026-11-02-specialist-claude-agent-design.md`

## Global Constraints
- Name schema: non-empty, max 256 chars, regex `^[A-Za-z0-9][A-Za-z0-9_.:-]*$`.
- Only task sessions get `--agent`; the home/sidebar session (`isHomeAgentSessionId(taskId)`) never does.
- If the launch args already contain `--agent`, do not add another.
- `--model` behavior from `claudeModel` is unchanged.
- `HAND_OFF_CYCLE` (`src/core/hand-off-cap.ts:3`) is unchanged.
- No `any`; top-level imports only (AGENTS.md).

## Review Focus
1. A legacy card / session summary without `claudeAgent` still parses; pinned in Task 1.
2. A name starting with `-` or containing a space is rejected everywhere it enters (schema, CLI); pinned in Tasks 1 and 2.
3. A resumed task (`--continue`) keeps `--agent`; pinned in Task 1.
4. Specialist edited on the card after start still scores the launched name; pinned in Task 2.
5. A UI board save keeps `claudeAgent` on every rebuild path; pinned in Task 3.

## Dependencies
Task 1 first. Tasks 2 and 3 both wait on Task 1 and can run in parallel.

---

### Task 1: Data, adapter, session, score key (agent: codex)

**Files:**
- Create: `src/core/claude-agent.ts`, `test/runtime/core/claude-agent.test.ts`
- Modify: `src/core/api-contract.ts` (card schema ~203 next to `claudeModel`; session summary schema ~361), `src/terminal/agent-session-adapters.ts` (`AgentAdapterLaunchInput` ~39, `claudeAdapter.prepare` ~435), `src/terminal/session-manager.ts` (request ~98, ~340; summary ~354, ~519, ~566), `src/trpc/runtime-api.ts` (session start ~424-438), `src/core/claude-model.ts` (`resolveScoreAgentKey` :18)
- Test: `test/runtime/core/claude-agent.test.ts`, `test/runtime/core/claude-model.test.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/terminal/session-manager.test.ts`, `test/runtime/trpc/runtime-api.test.ts`

**Interfaces:**
- Produces in `src/core/claude-agent.ts`:
  - `runtimeClaudeAgentSchema: z.ZodString` (constraints above)
  - `isRuntimeClaudeAgent(value: unknown): value is string`
  - `readCliAgentOption(args: readonly string[]): string | null` (handles `--agent x` and `--agent=x`, like `readCliModelOption`)
- Card field `claudeAgent?: string`; session summary field `claudeAgent?: string | null`; adapter input `claudeAgent?: string`.
- `resolveScoreAgentKey(input: { agentId; sessionClaudeModel?; cardClaudeModel?; defaultClaudeModel?; sessionClaudeAgent?: string | null; cardClaudeAgent?: string }): string` — for `agentId === "claude"`: `sessionClaudeAgent` if a non-null string; else if `sessionClaudeAgent === undefined` and `cardClaudeAgent` set, `cardClaudeAgent`; else the existing model logic. Non-claude unchanged.

- [ ] **Step 1: Failing tests**
  - `claude-agent.test.ts`: schema accepts `debugger`, `database-admin`, `ecc:typescript-reviewer`; rejects `""`, `-x`, `a b`, 257 chars. `readCliAgentOption(["--agent","debugger"]) === "debugger"`, `(["--agent=x"]) === "x"`, `([]) === null`.
  - `claude-model.test.ts`: `resolveScoreAgentKey({agentId:"claude", sessionClaudeAgent:"debugger", sessionClaudeModel:"opus"}) === "debugger"`; `({agentId:"claude", sessionClaudeAgent:null, sessionClaudeModel:"haiku", cardClaudeAgent:"debugger"}) === "haiku"` (session ran without agent); `({agentId:"claude", cardClaudeAgent:"debugger"}) === "debugger"`; `({agentId:"codex", cardClaudeAgent:"debugger"}) === "codex"`.
  - Adapter: task card with `claudeAgent:"debugger"` → args contain `["--agent","debugger"]` once; unset → no `--agent`; args already `--agent foo` → no second; home session id → none; `resumeFromTrash` → still present with `--continue`.
  - Card schema parses a card without `claudeAgent`, and rejects `claudeAgent:"-x"`.
  - Session manager: summary `claudeAgent` = launched `--agent` value, `null` when absent, `null` for non-claude agents.
  - Runtime API: starting a task whose card has `claudeAgent` passes it to the session manager (assert in `runtime-api.test.ts`, not only core tests).
- [ ] **Step 2:** `npx vitest run test/runtime/core test/runtime/terminal test/runtime/trpc/runtime-api.test.ts` → new tests FAIL.
- [ ] **Step 3:** Implement per Interfaces; plumb exactly like `claudeModel` (only when the resolved agent is `claude`).
- [ ] **Step 4:** Same vitest command → PASS. Then `npm run typecheck && npm run lint && npm run test:fast` → all pass.
- [ ] **Step 5:** Commit `feat(runtime): launch claude task sessions as a specialist agent`.

### Task 2: CLI, sidebar prompt, score callers (agent: opencode)

**Files:**
- Modify: `src/commands/task.ts` (create/update options, list output, pass/fail scoring), `src/trpc/runtime-api.ts` (`recordTaskAssignment` ~164-177, `task send` fail ~584), `src/trpc/app-router.ts` (handoff fail scoring), `src/prompts/append-system-prompt.ts` (`task create` ~207, `task update` ~226 references and the rule at ~338)
- Test: new `test/runtime/task-command-claude-agent.test.ts`, `test/runtime/agent-score-recording.test.ts`, `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Consumes from Task 1: `runtimeClaudeAgentSchema`, card `claudeAgent`, session summary `claudeAgent`, extended `resolveScoreAgentKey`.
- CLI flag `--claude-agent <name>` on `task create` and `task update`; `default` on update clears.

- [ ] **Step 1: Failing tests**
  - CLI: `task create --agent-id claude --claude-agent debugger` stores `claudeAgent:"debugger"`; `task update --claude-agent default` removes it; `--claude-agent debugger` with `--agent-id codex` errors; `--claude-agent "-x"` and `"a b"` error; `task list` output includes `claudeAgent`.
  - Scores: pass on a task whose session summary has `claudeAgent:"debugger"` records key `debugger`; card later changed to `database-admin` still records `debugger`; `assigned` and `task send` fail use the same key.
  - Prompt: contains `--claude-agent`, and the routing text: specialists are the user's own Claude Code agents in `~/.claude/agents/` that can edit files; route only when the task is mainly that specialty; specialist prompts must say to implement the change and run the acceptance commands; plugin agents only when the user names one; tell the user in one line why a task was routed.
- [ ] **Step 2:** `npx vitest run test/runtime/task-command-claude-agent.test.ts test/runtime/agent-score-recording.test.ts test/runtime/append-system-prompt.test.ts` → FAIL.
- [ ] **Step 3:** Implement, mirroring `--model` parsing/validation (`parseTaskClaudeModel`, `src/commands/task.ts:123`) and passing `sessionClaudeAgent`/`cardClaudeAgent` at every `resolveScoreAgentKey` call site.
- [ ] **Step 4:** Same command → PASS; then `npm run typecheck && npm run lint && npm run test:fast`.
- [ ] **Step 5:** Commit `feat(cli): route and score tasks by claude specialist agent`.

### Task 3: UI card label and board-state threading (agent: antigravity)

**Files:**
- Modify: `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts` (`normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, `disableTaskAutoReview`), `web-ui/src/components/board-card.tsx` (~444 agent label)
- Test: `web-ui/src/state/board-state.test.ts`, `web-ui/src/components/board-card.test.tsx`

**Interfaces:**
- Consumes from Task 1: card field `claudeAgent?: string`.

- [ ] **Step 1: Failing tests**
  - board-state: one test per listed function, each asserting a card with `claudeAgent:"debugger"` keeps it after the call; `normalizeCard` drops an invalid value (e.g. `"-x"`) and keeps a valid one.
  - board-card: a `claude` card with `claudeAgent:"debugger"` shows `Claude · debugger`; without it shows `Claude`; a `codex` card with a stale `claudeAgent` shows `Codex`.
- [ ] **Step 2:** `npm --prefix web-ui run test -- board-state board-card` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same → PASS; then `npm run typecheck && npm run lint && npm run test:fast` and `npm --prefix web-ui run typecheck`.
- [ ] **Step 5:** Commit `feat(web-ui): show and keep the claude specialist agent on cards`.
