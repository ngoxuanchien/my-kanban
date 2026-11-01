# Claude Model Per Task Implementation Plan

> **For agentic workers:** each task below is one Kanban task, run in its own worktree. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `claude` task can run with `--model haiku|sonnet|opus`, chosen in the UI or via `--model` in the CLI. Scores are split per model.

**Architecture:** A shared enum plus helpers live in `src/core/claude-model.ts`. The card stores `claudeModel`, and runtime config stores `claudeDefaultModel` (default `opus`). When a task session starts, the effective model goes to the Claude adapter, which appends `--model`; the session summary records the model that was actually launched. Score events for `claude` tasks use that recorded model as their key.

**Tech Stack:** TypeScript, zod, commander (CLI), vitest, React + Tailwind (web-ui).

**Spec:** `docs/superpowers/specs/2026-11-01-claude-model-per-task-design.md`

## Global Constraints
- Allowed models: exactly `haiku`, `sonnet`, `opus`. Default `claudeDefaultModel` = `opus`.
- The home/sidebar Claude session (`isHomeAgentSessionId(taskId)`) never gets `--model` from this feature.
- If the launch args already contain `--model`, do not add another.
- `HAND_OFF_CYCLE` (`src/core/hand-off-cap.ts:3`) is unchanged.
- No `any`; top-level imports only (AGENTS.md).

## Review Focus
1. A legacy card or config without the new fields still loads; this is pinned in Task 1 (schema parse test).
2. A home session with `claudeDefaultModel` set gets no `--model`; pinned in Task 1.
3. User-supplied `--model x` in the args is not duplicated, and the recorded model is `x` only if `x` is an allowed alias; pinned in Task 1.
4. A model edited mid-task still scores the session's launch model; pinned in Task 2.
5. Legacy `claude` score events merge into `opus` without double counting the same task; pinned in Task 2.

## Dependencies
Task 1 must be done first. Tasks 2 and 3 both wait on Task 1 and can run in parallel.

---

### Task 1: Data, config, adapter, session (agent: opencode)

**Files:**
- Create: `src/core/claude-model.ts`, `test/runtime/core/claude-model.test.ts`
- Modify: `src/core/api-contract.ts` (card schema ~199, session summary schema 352-369, runtime config response/save schemas), `src/config/runtime-config.ts` (next to `selectedAgentId`, lines 14/29/41/277/310), `src/terminal/agent-session-adapters.ts` (`AgentAdapterLaunchInput` 24-37, `claudeAdapter.prepare` 410+), `src/terminal/session-manager.ts` (start request + summary ~334, ~500), `src/trpc/runtime-api.ts` (`startTaskSession` 286+)
- Test: `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/config/` (existing runtime-config test file), `test/runtime/core/claude-model.test.ts`

**Interfaces (produces):**
- `src/core/claude-model.ts`:
  - `export const runtimeClaudeModelSchema = z.enum(["haiku", "sonnet", "opus"]);`
  - `export type RuntimeClaudeModel = z.infer<typeof runtimeClaudeModelSchema>;`
  - `export const DEFAULT_CLAUDE_MODEL: RuntimeClaudeModel = "opus";`
  - `export function isRuntimeClaudeModel(value: unknown): value is RuntimeClaudeModel`
  - `export function resolveEffectiveClaudeModel(cardModel: RuntimeClaudeModel | undefined, defaultModel: RuntimeClaudeModel | undefined): RuntimeClaudeModel` returns card, else default, else `DEFAULT_CLAUDE_MODEL`.
  - `export function readCliModelOption(args: readonly string[]): string | null` reads the value of `--model x` or `--model=x`, else `null`.
- Card: `claudeModel?: RuntimeClaudeModel` on `runtimeBoardCardSchema`.
- Runtime config: `claudeDefaultModel: RuntimeClaudeModel` (resolved, default `opus`) on the config response; optional on the save input; persisted in global config.
- `AgentAdapterLaunchInput.claudeModel?: RuntimeClaudeModel`, and the same optional field on the session-manager start request.
- Session summary: `claudeModel: z.string().nullable().optional()`, the model the session actually launched with.

- [ ] **Step 1: Failing tests**
  - `claude-model.test.ts`:
    - `resolveEffectiveClaudeModel("haiku", "opus") === "haiku"`
    - `resolveEffectiveClaudeModel(undefined, "sonnet") === "sonnet"`
    - `resolveEffectiveClaudeModel(undefined, undefined) === "opus"`
    - `readCliModelOption(["--model","sonnet"]) === "sonnet"`
    - `readCliModelOption(["--model=x"]) === "x"`
    - `readCliModelOption([]) === null`
  - Adapter tests (agentId `claude`):
    - `claudeModel: "haiku"` → args contain `["--model","haiku"]` exactly once.
    - args `["--model","opus"]` with `claudeModel: "haiku"` → still exactly one `--model`, whose value is `opus`.
    - no `claudeModel` → no `--model` added.
  - Runtime/session test:
    - starting task `t1` whose card has no `claudeModel`, with config `claudeDefaultModel: "opus"` → launch args include `--model opus`, and the summary has `claudeModel: "opus"`.
    - starting the home session id with the same config → no `--model` in the args, and the summary's `claudeModel` is null or absent.
    - args with user `--model custom-x` → summary `claudeModel` is `null`; args with `--model sonnet` → summary is `"sonnet"`.
  - Schema test: parsing a card without `claudeModel`, and a config without `claudeDefaultModel`, succeeds; the config resolves to `"opus"`.
- [ ] **Step 2: Run** `npx vitest run test/runtime/core/claude-model.test.ts test/runtime/terminal/agent-session-adapters.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `runtime-api.startTaskSession`: for a non-home task whose effective agent is `claude`, pass `resolveEffectiveClaudeModel(card.claudeModel, config.claudeDefaultModel)`.
  - Adapter: push `--model` unless `hasCliOption(args, "--model")`.
  - Session manager: set `summary.claudeModel` from the final args via `readCliModelOption`, keeping it only if `isRuntimeClaudeModel`; otherwise `null`. Only for agent `claude`.
  - Resume (`--continue`) paths go through the same code, so a resumed session also gets `--model`.
- [ ] **Step 4: Run** the same tests, then `npm run typecheck && npm run lint && npm run test:fast`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(runtime): launch claude task sessions with a per-task model`

### Task 2: CLI, sidebar prompt, scoring (agent: antigravity)

**Files:**
- Modify: `src/commands/task.ts` (`task create` ~1264, `task update` ~1330, list output ~420, score at ~346), `src/prompts/append-system-prompt.ts` (CLI reference for create/update), `src/trpc/runtime-api.ts` (`recordTaskAssignment` 158-170, `task send` fail ~564), `src/trpc/app-router.ts` (~569 handoff fail), `src/state/agent-scores.ts` (`summarizeAgentScoreEvents`), `src/core/claude-model.ts` (add the score helper)
- Test: `test/runtime/task-command-agent-id.test.ts` (or a new `test/runtime/task-command-model.test.ts`), `test/runtime/agent-score-recording.test.ts`, `test/runtime/state/` (agent-scores summary test), `test/runtime/append-system-prompt.test.ts`

**Interfaces:**
- Consumes (from Task 1): `runtimeClaudeModelSchema`, `RuntimeClaudeModel`, `resolveEffectiveClaudeModel`, `card.claudeModel`, `config.claudeDefaultModel`, `summary.claudeModel`.
- Produces, in `src/core/claude-model.ts`: `export function resolveScoreAgentKey(input: { agentId: string; sessionClaudeModel?: string | null; cardClaudeModel?: RuntimeClaudeModel; defaultClaudeModel?: RuntimeClaudeModel }): string`.
  - If `agentId !== "claude"`, return `agentId`.
  - If the session has a launch model: return it when `isRuntimeClaudeModel(sessionClaudeModel)`, otherwise `"claude"`.
  - If the session has no launch model: return `resolveEffectiveClaudeModel(card, default)`.

- [ ] **Step 1: Failing tests**
  - CLI:
    - `task create --agent-id claude --model sonnet` → `task list` shows `claudeModel: "sonnet"`.
    - `task update --task-id X --model default` → the field is gone.
    - `task create --agent-id codex --model haiku` → `ok: false`, and the error names `--model`.
    - `--model gpt` → `ok: false`.
    - With no `--agent-id` and `selectedAgentId: "claude"`, `--model haiku` is accepted.
    - `task update --agent-id codex` on a card with `claudeModel` keeps the field.
  - Scores:
    - `resolveScoreAgentKey` cases: codex → `codex`; claude with session `haiku` and card `sonnet` → `haiku`; claude with session `"custom-x"` → `claude`; claude with no session model and no card model, default `opus` → `opus`.
    - Recording a pass on a `claude` card whose session launched with `haiku` yields an event with `agentId: "haiku"`.
  - Summary: events `[{assigned, claude, t1}, {pass, claude, t1}, {assigned, opus, t1}, {pass, opus, t2}]` → a single `opus` entry with `passes: 2, tasks: 1`, and no `claude` entry.
  - Prompt: the sidebar prompt text contains `--model <haiku|sonnet|opus>` and the rule to use it only when the user names a Claude model.
- [ ] **Step 2: Run** the new and changed test files. Expected: FAIL.
- [ ] **Step 3: Implement**
  - Parse `--model` with `runtimeClaudeModelSchema`; `default` clears the field (update only).
  - Validate against the effective agent: card `agentId`, else `selectedAgentId`.
  - Every score recording site calls `resolveScoreAgentKey` with the card, `state.sessions[taskId]?.claudeModel`, and the config.
  - `summarizeAgentScoreEvents` maps `agentId === "claude"` to `"opus"` before accumulating. Events with key `claude` that are written after this change come from non-alias custom models, and they map to `opus` too. That is accepted, since the user's normal model is opus.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm run test:fast`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(cli): choose and score claude tasks per model`

### Task 3: UI picker and default model setting (agent: codex)

**Files:**
- Modify: `web-ui/src/components/task-agent-model-picker.tsx`, `web-ui/src/components/task-create-dialog.tsx`, `web-ui/src/components/task-inline-create-card.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`, plus whichever create/update payload builder sends `agentId` today (e.g. `web-ui/src/hooks/app-utils.tsx`)
- Test: `web-ui/src/components/task-agent-model-picker.test.tsx`, `web-ui/src/components/runtime-settings-dialog.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `card.claudeModel`, the config fields `claudeDefaultModel` (response) and `claudeDefaultModel` (save input), and the type `RuntimeClaudeModel` re-exported through `@/runtime/types`.
- Produces: the picker props `claudeModel?: RuntimeClaudeModel` and `onClaudeModelChange(model: RuntimeClaudeModel | undefined)`.

- [ ] **Step 1: Failing tests**
  - Picker with effective agent `claude` and `claudeDefaultModel: "opus"`:
    - renders a select with options `Default (opus)`, `haiku`, `sonnet`, `opus`;
    - choosing `haiku` calls `onClaudeModelChange("haiku")`;
    - choosing `Default (opus)` calls it with `undefined`.
  - With agent `codex`, there is no Claude model select.
  - Settings dialog shows a "Default Claude model" select; saving sends `claudeDefaultModel`.
- [ ] **Step 2: Run** `npm --prefix web-ui run test -- task-agent-model-picker runtime-settings-dialog`. Expected: FAIL.
- [ ] **Step 3: Implement** using the existing `NativeSelect` (`@/components/ui/native-select`), styled like the Cline model row. Create and inline-create pass `claudeModel` in the create payload; wherever a backlog card's agent can be edited today, its Claude model can be edited too (send `claudeModel`, or clear it).
- [ ] **Step 4: Run** the web-ui tests plus `npm run typecheck && npm run lint` (root and web-ui, as the repo scripts define). Expected: all pass.
- [ ] **Step 5: Commit** `feat(web-ui): pick the claude model per task and set the default`
