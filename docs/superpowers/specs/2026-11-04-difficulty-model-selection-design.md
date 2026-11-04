# Difficulty-based model selection for task agents

Date: 2026-11-04

## Why

The owner runs Claude Code (Pro, often at its limit), Codex (ChatGPT plan with a usage limit), and OpenCode (free models, shared quota). Today Kanban only picks a model for Claude; Codex and OpenCode always use whatever their own config says, so easy tasks burn the strongest model and hard tasks may get a weak one. The owner wants each task to carry a **difficulty score**, and the model (and, for Codex, the reasoning effort) to follow from that score, for every agent. The sidebar agent scores tasks it creates; the owner can score or override on the UI without the sidebar.

This reverses the 2026-10-29 decision "no up-front model router; hand off instead" (`contexte/memory-orchestrator.md`). Handoff stays; model choice is added on top.

## Goals

- Every task can have a difficulty `1`–`5`. The sidebar always sets it on tasks it creates (`task create --difficulty`), with a one-line reason recorded as a task comment.
- A **difficulty → model table** per agent decides the model when the task does not name one. Kanban ships defaults; the owner edits the table in Settings. The sidebar reads the live table (no copy in its prompt).
- Codex and OpenCode get a per-task model choice, like Claude has today. Codex also gets a per-task reasoning effort.
- The owner can set or change difficulty, model, and effort on the UI (create dialog, task edit, card), for any task, including sidebar-created ones.
- Kanban knows which model and effort a session was actually launched with, and uses it for agent scores (split per agent + model) and for the GitHub issue comment (spec `2026-11-04-github-issue-sync-design.md`).
- `task models` CLI command prints, per agent: the available models (with descriptions and supported efforts), the current difficulty table, and review pass/fail counts per model.

## Non-goals

- No Antigravity model choice (owner chose Codex + OpenCode).
- No OpenCode reasoning effort (no CLI flag; free models; provider-specific config).
- No automatic difficulty bump on review failure or handoff: **a handed-off task keeps its difficulty** (owner), and the new agent's model comes from the table for that agent.
- No learning/automatic table tuning from scores. Scores are shown; the owner edits the table.

## Anti-goals

- Launching an agent with a model it rejects and leaving the task stuck. If a mapped model is not in the agent's current catalog, launch with the agent's own default and warn (task comment), instead of failing.
- A UI board save silently dropping the new card fields (AGENTS.md: thread every new card field through all rebuild sites in `web-ui/src/state/board-state.ts`, with a web-ui test per path, as `claudeModel` did).
- Writing to the owner's global agent config (`~/.codex`, `~/.config/opencode`). Kanban only reads catalogs and passes per-session flags/configs.

## Decided

### Data
- Card fields (optional): `difficulty: 1|2|3|4|5`; `agentModel: string` (Codex or OpenCode model id); `agentReasoningEffort: string` (Codex only). Claude keeps its existing `claudeModel`. An explicit `agentModel` belongs to the card's current agent; changing the agent (UI, `task update --agent-id`, or handoff) clears `agentModel` and `agentReasoningEffort`.
- Global runtime config (same file and level as `claudeDefaultModel`, not per project; assistant's call): `difficultyModelMap: { codex?: Record<1..5, { model?: string; reasoningEffort?: string }>; opencode?: Record<1..5, { model?: string }>; claude?: Record<1..5, { model?: RuntimeClaudeModel }> }`. Missing cell = agent default.
- Shipped defaults (assistant's call, owner edits in Settings): codex 1–2 `gpt-6-luna`/`low`, 3 `gpt-6.1-sol`/`medium`, 4 `gpt-6.1-sol`/`high`, 5 `gpt-6-astra`/`high`; claude 1–2 `haiku`, 3–4 `sonnet`, 5 `opus`; opencode all empty (its free quota is shared across models, so switching does not help).

### Resolution at session start (one shared function)
1. Explicit card model (`claudeModel` for claude, `agentModel`/`agentReasoningEffort` for codex/opencode).
2. Else `difficultyModelMap[agent][difficulty]` when the card has a difficulty.
3. Else for claude the existing `claudeDefaultModel`; for codex/opencode no override (agent's own config).
The resolved model/effort is recorded on the session summary, the same way `claudeModel` is today, and is what scores and issue comments use.

Resolution details (assistant's calls):
- **Codex pair rule:** an explicit `agentModel` wins as a whole: launch with it plus the explicit `agentReasoningEffort` if set, otherwise no effort flag (Codex then uses that model's `default_reasoning_level`); the table is not consulted. Without an explicit model, use the table cell's model and effort, with an explicit `agentReasoningEffort` replacing the table's effort.
- **No override:** when step 3 gives no model for codex/opencode, Kanban records no model (null). Scores use the plain key (`codex`, `opencode`), the issue comment shows the agent only, and `task models` lists those under "default". Kanban does not read `~/.codex/config.toml` or the OpenCode config to guess.
- **Catalog check:** applies to both explicit and table models. If the catalog could be read and the model is not in it, launch without the model (and without effort) and add a warning task comment. If the catalog could not be read, pass the model through unchecked; an agent that exits at once is already covered by the existing crash handoff.

### Catalogs
- Codex: `codex debug models` JSON; keep entries with `visibility: "list"`; use `slug`, `display_name`, `description`, `supported_reasoning_levels[].effort`, `default_reasoning_level`.
- OpenCode: `opencode models`, one id per line.
- Claude: the existing `haiku|sonnet|opus` aliases.
- Read by the runtime with `execFile` (no shell), cached for the runtime's lifetime with a manual refresh; on failure the UI falls back to a free-text model field and the CLI accepts any string.

### Launch
- Codex: `-m <model>` and `-c model_reasoning_effort=<effort>` (Kanban already passes `-c` options in `src/terminal/agent-session-adapters.ts:555`), unless the user's agent args already set them.
- OpenCode: its TUI rejects `--model` (`agent-session-adapters.ts:815`). Write a **per-task** OpenCode config (today one shared `opencode.json` is generated at `:789`) that contains the Kanban plugin plus `"model": "<id>"`, and point `OPENCODE_CONFIG` at it. Without a model, behave as today.
- Effort is validated against the chosen model's supported levels; an unsupported effort is dropped with a warning.

### Sidebar agent
- Prompt (`src/prompts/append-system-prompt.ts`) gets a difficulty rubric (1 = one-file text/config change; 2 = small fix in 1–2 files with a test; 3 = small feature in 2–4 files; 4 = feature across runtime + CLI or runtime + UI, or tricky state/concurrency; 5 = multi-layer change with migration, concurrency, or security weight) and the rule: always pass `--difficulty`; pass `--model`/`--reasoning-effort` only when the user names a model; before creating tasks run `task models` once to see the live table and catalogs; record the score reason with the task comment mechanism.
- Agent choice (which agent gets the task) stays as today (rotation / user's naming).

### CLI
- `task create`/`task update`: `--difficulty <1-5>`; `--model` now also accepts Codex/OpenCode model ids when the effective agent is codex/opencode (today claude-only check in `src/commands/task.ts` `createTask`); `--reasoning-effort <level>` (codex only). `--model default` / `--reasoning-effort default` clear the override.
- `task models [--agent <id>]`: plain text, per agent: table rows `difficulty → model/effort`, catalog lines `id — description [efforts]`, and `pass/fail` counts per model from agent scores.
- `task list` line shows `d<n>` when the task has a difficulty.

### Web UI
- Create dialog and task edit: difficulty selector (1–5, or none) and, per agent, a model picker showing "Auto (difficulty n → <model>)" as the default option, the catalog models, and for codex an effort picker limited to the chosen model's levels. Extend the existing `web-ui/src/components/task-agent-model-picker.tsx` pattern.
- Card: a small `D3` badge; the agent line shows the resolved model.
- Settings: a "Model by difficulty" table (rows 1–5, columns codex / opencode / claude), cells are model (+ effort for codex) pickers from the catalogs, with "Default".

### Scores
- Extend the existing per-model score key (`resolveScoreAgentKey`, `src/core/claude-model.ts:18`) to codex/opencode using the session's recorded model, e.g. `codex:gpt-6.1-sol`; no recorded model → plain `codex` / `opencode`. Existing Claude keys and stored `agent-scores.json` events stay as they are (no migration; assistant's call). Bottom score bar shows them like the Claude split.

## Left to the builder

- Exact names of new zod schemas, tRPC procedures for catalogs, and file layout (e.g. `src/core/agent-model.ts`, `src/terminal/agent-model-catalog.ts`).
- Per-task OpenCode config file location (under the Kanban hook directory, keyed by task id) and its cleanup.
- UI layout details within the design tokens and AGENTS.md web-ui rules.

## Acceptance

- Unit tests: resolution order (explicit > table > default) for each agent; agent change clears `agentModel`/effort; handoff keeps `difficulty`; codex args contain `-m` and `-c model_reasoning_effort=` only when resolved; OpenCode per-task config contains `model` and the plugin, two tasks get different files; unmapped/unknown model → agent default + warning comment; catalog parse of a captured `codex debug models` fixture and `opencode models` output; catalog command failure → free text; `task create --difficulty` validation (1–5); `task models` output; score key per codex/opencode model; web-ui: every `board-state.ts` rebuild path keeps `difficulty`, `agentModel`, `agentReasoningEffort`; Settings table saves `difficultyModelMap`.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`, and web-ui tests pass.

## Ordering

Starts after the three GitHub issue sync tasks land (they touch `api-contract.ts`, `runtime-config.ts`, `src/commands/task.ts`, and the sidebar prompt).
