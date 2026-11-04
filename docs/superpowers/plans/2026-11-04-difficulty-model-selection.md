# Difficulty Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each task carries a difficulty 1–5; a per-agent difficulty → model/effort table (editable in Settings) picks the model for Claude, Codex and OpenCode at launch; the sidebar scores every task it creates.

**Architecture:** New optional card fields + a global config table feed one pure resolver (`resolveTaskAgentModel`) used at session start. Model catalogs come from `codex debug models` / `opencode models`, cached in the runtime. Codex gets `-m`/`-c model_reasoning_effort=`; OpenCode gets a per-task generated config. The session summary records what was launched; scores and the GitHub issue comment read it.

**Tech Stack:** Node/TypeScript runtime, zod, tRPC, vitest; React + Tailwind v4 web-ui.

**Spec:** `docs/superpowers/specs/2026-11-04-difficulty-model-selection-design.md`

## Global Constraints

- Difficulty is an integer `1`–`5`; anything else is rejected by schema and CLI.
- Never write to `~/.codex` or `~/.config/opencode`; catalogs are read with `execFile` (no shell, no `zsh -i`).
- Every new card field (`difficulty`, `agentModel`, `agentReasoningEffort`) is threaded through every rebuild in `web-ui/src/state/board-state.ts`: `normalizeCard`, `addTaskToColumnWithResult`, `updateTask`, `updateTaskTitle`, `applyTaskDetailClineSettingsSelection`, `applyTaskDetailClineSettingsChange`, `disableTaskAutoReview` — with a web-ui test per path.
- Changing a card's agent (UI, `task update --agent-id`, handoff) clears `agentModel` and `agentReasoningEffort`; `difficulty` is kept.
- Shipped `difficultyModelMap` defaults, verbatim: codex 1–2 `gpt-6-luna`/`low`, 3 `gpt-6.1-sol`/`medium`, 4 `gpt-6.1-sol`/`high`, 5 `gpt-6-astra`/`high`; claude 1–2 `haiku`, 3–4 `sonnet`, 5 `opus`; opencode empty.
- No test runs the real `codex` or `opencode`; catalog parsing uses captured fixtures. Tests that spawn `git` pass `env: createGitTestEnv()`.

## Review Focus

1. A card saved by the UI right after a CLI `--difficulty`/`--model` update keeps all three fields. (Task 4: board-state path tests.)
2. Handoff codex → opencode with an explicit codex `agentModel` → opencode launches with its table/default, never with the codex id. (Task 2: `handoff clears agentModel`.)
3. `codex debug models` prints non-JSON or exits non-zero → catalog `{ ok:false }`, launch still passes the model unchecked, UI falls back to free text. (Task 1 + Task 2 tests.)
4. User agent args already contain `-m`/`--model` or `model_reasoning_effort` → Kanban does not add a second one. (Task 2: `respects user args`.)
5. Two OpenCode tasks running at once with different models → different config files, each with the Kanban plugin. (Task 2.)

---

### Task 1: Data, config table, catalogs, resolver

**Files:**
- Create: `src/core/agent-model.ts`, `src/terminal/agent-model-catalog.ts`, `test/runtime/core/agent-model.test.ts`, `test/runtime/terminal/agent-model-catalog.test.ts`, `test/fixtures/codex-debug-models.json`, `test/fixtures/opencode-models.txt`
- Modify: `src/core/api-contract.ts` (`runtimeBoardCardSchema` at `:196`, session summary at `:364`, config schemas), `src/config/runtime-config.ts` (global config field + defaults), `src/trpc/runtime-api.ts` + `src/trpc/app-router.ts` (catalog query)

**Interfaces — Produces:**
- `type TaskDifficulty = 1 | 2 | 3 | 4 | 5`; `runtimeTaskDifficultySchema`.
- Card: `difficulty?: TaskDifficulty; agentModel?: string; agentReasoningEffort?: string`.
- `interface DifficultyModelCell { model?: string; reasoningEffort?: string }`; `type DifficultyModelMap = { codex?: Partial<Record<TaskDifficulty, DifficultyModelCell>>; opencode?: …; claude?: Partial<Record<TaskDifficulty, { model?: RuntimeClaudeModel }>> }`; `DEFAULT_DIFFICULTY_MODEL_MAP`; `RuntimeConfigState.difficultyModelMap: DifficultyModelMap` (global, saved by `runtime.saveConfig`).
- `resolveTaskAgentModel(input: { agentId: RuntimeAgentId; card: Pick<RuntimeBoardCard, "difficulty" | "agentModel" | "agentReasoningEffort" | "claudeModel">; map: DifficultyModelMap; claudeDefaultModel: RuntimeClaudeModel }): { model: string | null; reasoningEffort: string | null; source: "card" | "difficulty" | "default" }`.
- `interface AgentModelCatalogEntry { id: string; displayName?: string; description?: string; efforts: string[]; defaultEffort?: string }`; `type AgentModelCatalog = { ok: true; models: AgentModelCatalogEntry[] } | { ok: false; error: string }`; `parseCodexModelCatalog(json: string): AgentModelCatalog`; `parseOpenCodeModelCatalog(text: string): AgentModelCatalog`; `loadAgentModelCatalog(agentId: "codex" | "opencode" | "claude", options?: { refresh?: boolean }): Promise<AgentModelCatalog>` (cached per runtime).
- tRPC `runtime.getAgentModelCatalogs` query `{ refresh?: boolean } → Record<"codex" | "opencode" | "claude", AgentModelCatalog>`.

- [ ] **Step 1: Failing tests** (`agent-model.test.ts`): for each agent — explicit card model wins (codex pair rule: explicit `agentModel` without effort → `reasoningEffort: null`, table ignored); no explicit model → table cell model+effort, explicit `agentReasoningEffort` replaces table effort; no difficulty/no cell → claude `claudeDefaultModel`, codex/opencode `{ model: null, reasoningEffort: null, source: "default" }`; defaults equal the Global Constraints values. Schema: difficulty `0`, `6`, `2.5` rejected. Catalog tests: fixture → only `visibility: "list"` entries, `gpt-6-luna` efforts exclude `ultra`; opencode fixture → 9 ids; invalid JSON → `{ ok:false }`. Config tests: missing → defaults; saved map round-trips in the global config file.
- [ ] **Step 2:** `npx vitest run test/runtime/core/agent-model.test.ts test/runtime/terminal/agent-model-catalog.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Fixture formats: codex `{"models":[{"slug","display_name","description","visibility","default_reasoning_level","supported_reasoning_levels":[{"effort"}]}]}`; opencode one `provider/model` per line. Trim fixtures to the fields used.
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` → pass.
- [ ] **Step 5: Commit** `feat: task difficulty, difficulty model table, agent model catalogs`.

### Task 2: Launch, session record, scores, agent change

**Files:**
- Modify: `src/terminal/agent-session-adapters.ts` (codex adapter near `:555`, opencode adapter `:768-830`), `src/terminal/session-manager.ts` (`:98`, `:340-566`), `src/trpc/runtime-api.ts` (`:184`, `:415-483`), `src/core/claude-model.ts` (`resolveScoreAgentKey` `:18`), `src/core/api-contract.ts` (session summary `agentModel`, `agentReasoningEffort`), `src/server/hand-off-task.ts`, the task-update path that changes `agentId`
- Test: `test/runtime/terminal/agent-session-adapters.test.ts`, `test/runtime/terminal/session-manager.test.ts`, `test/runtime/trpc/runtime-api.test.ts`, the hand-off test, score key tests

**Interfaces:**
- Consumes: `resolveTaskAgentModel`, `loadAgentModelCatalog` (Task 1).
- Produces: session summary `agentModel: string | null`, `agentReasoningEffort: string | null` (launched values; claude keeps `claudeModel`); `resolveScoreAgentKey` returns `codex:<model>` / `opencode:<model>` when the session recorded a model, else `codex` / `opencode`; Claude keys unchanged.

- [ ] **Step 1: Failing tests:** codex args contain `-m gpt-6.1-sol` and `-c model_reasoning_effort=high` when resolved, neither when `model: null`; `respects user args` (existing `-m`/`--model`/`model_reasoning_effort` in agent args → nothing added); opencode with a model → `OPENCODE_CONFIG` points at a task-specific file containing `"model"` and the plugin; two task ids → two files; no model → today's shared config; catalog ok and model missing → launched without model/effort + a `comment` history event naming the dropped model; catalog `ok:false` → model passed unchecked; effort not in the model's `efforts` → dropped with warning; session summary records launched values (wiring test in `runtime-api.test.ts` and `session-manager.test.ts`, not only core helpers — see `contexte/claude-model-per-task.md`); `handoff clears agentModel` and keeps `difficulty`; `task update --agent-id` clears both; score key tests.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. Resolve once in `runtime-api.ts` where `claudeModel` is resolved today (`:441-450`) and pass `agentModel`/`agentReasoningEffort` through the start request.
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` → pass.
- [ ] **Step 5: Commit** `feat: launch codex/opencode with the resolved model and record it`.

### Task 3: CLI flags, `task models`, sidebar rubric, issue comment

**Files:**
- Modify: `src/commands/task.ts` (`createTask` `:764`, update, list line, new `models` subcommand), `src/prompts/append-system-prompt.ts` (task create/update reference + rubric), `src/github/issue-sync.ts` (comment uses session `agentModel`/`agentReasoningEffort`)
- Test: existing task command tests, append-system-prompt test, `test/runtime/github/issue-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 schema/config/catalog query; Task 2 session fields and score keys.

- [ ] **Step 1: Failing tests:** `--difficulty 3` stored; `--difficulty 0|6|x` → error; `--model gpt-6.1-sol` accepted when the effective agent is codex, rejected for claude (claude keeps `haiku|sonnet|opus`); `--reasoning-effort` only for codex; `--model default`/`--reasoning-effort default` clear; `task list` line shows `d3`; `task models` prints per agent the table rows (`3 → gpt-6.1-sol/medium`), catalog lines (`gpt-6-luna — Fast and affordable model for easier tasks [low,medium,high,xhigh,max]`) and `pass/fail` per score key, and `catalog unavailable: <error>` when `ok:false`; prompt test: rubric text for 1–5 as in the spec, "always pass --difficulty", "pass --model/--reasoning-effort only when the user names a model", "run task models once before creating tasks", "record the score reason as a task comment"; issue comment `Moved to In progress (agent: codex, model: gpt-6.1-sol, effort: high)` from the session record, agent only when the session has no model.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` → pass.
- [ ] **Step 5: Commit** `feat(cli): task difficulty, codex/opencode model flags, task models`.

### Task 4: Web UI

**Files:**
- Modify: `web-ui/src/state/board-state.ts` (all rebuild sites listed in Global Constraints), `web-ui/src/components/task-agent-model-picker.tsx`, `web-ui/src/components/task-create-dialog.tsx`, `web-ui/src/components/card-detail-view.tsx` (task edit), `web-ui/src/components/board-card.tsx`, `web-ui/src/components/runtime-settings-dialog.tsx`
- Create: a hook for `runtime.getAgentModelCatalogs` (e.g. `web-ui/src/hooks/use-agent-model-catalogs.ts`), a Settings table component (e.g. `web-ui/src/components/difficulty-model-table.tsx`)
- Test: board-state tests (one per rebuild path), picker, create dialog, card, settings table tests

**Interfaces:**
- Consumes: Task 1 card fields, `difficultyModelMap` via `runtime.saveConfig`, `runtime.getAgentModelCatalogs`, `resolveTaskAgentModel` (import the shared core function; do not re-implement).

- [ ] **Step 1: Failing tests:** each board-state path keeps `difficulty`, `agentModel`, `agentReasoningEffort`; changing the agent in the UI clears `agentModel`/`agentReasoningEffort`, keeps `difficulty`; picker's first option reads `Auto (difficulty 3 → gpt-6.1-sol)` for codex and lists catalog models; effort options = the chosen model's `efforts`; catalog `ok:false` → free-text model input; card shows `D3` and the resolved model on the agent line; Settings table renders rows 1–5 × codex/opencode/claude, edits save `difficultyModelMap`, "Default" clears a cell.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement with Radix Select, `Button`, design tokens and `react-use` per AGENTS.md.
- [ ] **Step 4:** tests → PASS; `npm run typecheck && npm run lint && npm run test:fast` and web-ui tests → pass.
- [ ] **Step 5: Commit** `feat(web-ui): task difficulty and difficulty model table`.

## Order

All tasks start after the GitHub issue sync tasks land. Task 1 first; Tasks 2 and 4 after Task 1 (parallel); Task 3 after Task 2.
