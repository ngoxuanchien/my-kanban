# Claude model per task — design

Date: 2026-11-01
Status: approved by the user 2026-11-01
Builds on: `2026-10-29-agent-scoreboard-design.md`, `2026-10-30-sidebar-default-task-agent-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Why

The user wants to give some implementation tasks to Claude, picking the model per task: Haiku for small, cheap tasks, Sonnet or Opus for harder ones. **[user]** Today the `claude` task agent always runs Claude Code's own default model: the adapter never passes `--model` (`src/terminal/agent-session-adapters.ts:410-440`), and the card has no field for it. The user also wants to see on the score strip how each Claude model performs, the same way codex/opencode/antigravity are scored. **[user]**

Putting Claude models into the automatic codex → opencode → antigravity rotation was considered and rejected: it moves implementation load onto the Claude quota the reviewer needs, and blind rotation sends hard tasks to Haiku. **[user]**

## 2. Goals, non-goals, anti-goals

### Goals
- G1. A task whose agent is `claude` can carry a model: `haiku`, `sonnet` or `opus`. **[user]**
- G2. The model can be chosen both in the UI (task create dialog and inline create card) and from the sidebar via the CLI (`task create` / `task update --model`). **[user]**
- G3. The Claude task session starts with `--model <model>`. **[user]**
- G4. The score strip shows `haiku`, `sonnet`, `opus` as separate entries next to codex/opencode/antigravity, with no `claude` prefix, each with its own score (+1 pass, −1 fail) and assigned-task count. The combined `claude` entry disappears. **[user]**
- G5. A `claude` task with no model chosen runs and is scored as the **default Claude model**, a new runtime setting whose initial value is `opus` (the model the user normally runs). Kanban always passes `--model` from that setting, so the score always names the model that actually ran. **[user]**
- G6. Existing score events recorded under `claude` count as `opus`. **[user]**

### Non-goals
- Claude in the handoff cycle (`HAND_OFF_CYCLE`, `src/core/hand-off-cap.ts:3`) — unchanged. **[user]**
- The sidebar choosing Claude or a model on its own. The default task-agent rotation (codex → opencode → antigravity) is unchanged; the sidebar passes `--agent-id claude --model <m>` only when the user asks. **[user]**
- Full model IDs (`claude-opus-5-5`), free-text model entry, `[1m]` variants, reasoning effort. Only the three aliases Claude Code already accepts. **[assistant's call]**
- Model choice for the home/sidebar agent itself.
- Showing the model on the board card. **[assistant's call]** (not asked; easy follow-up)

### Anti-goals
- A score recorded under a model that did not actually run (e.g. the user changed `/model` and Kanban guessed).
- Old `claude` scores lost or shown as a separate stale `claude` entry.
- Breaking a user's custom Claude launch args: if the configured args already contain `--model`, Kanban does not add a second one. **[assistant's call]**

## 3. Data

- Card: new optional field `claudeModel: "haiku" | "sonnet" | "opus"` on `runtimeBoardCardSchema` (`src/core/api-contract.ts:~199`), next to `clineSettings`. Absent = use the default. **[assistant's call]** Mirrors how `clineSettings.modelId` is stored per task (`src/core/api-contract.ts:146-150`).
- The field is kept when the agent is changed away from `claude` and back (it is simply ignored for other agents). **[assistant's call]**
- Runtime config: new `claudeDefaultModel: "haiku" | "sonnet" | "opus"`, default `opus`, in `src/config/runtime-config.ts` next to `selectedAgentId`. Editable in the runtime settings dialog (`web-ui/src/components/runtime-settings-dialog.tsx`). **[assistant's call]**
- One shared zod enum / helper for the three values and for "effective model = card.claudeModel ?? config.claudeDefaultModel". **[builder]** where it lives.

## 4. CLI and sidebar

- `task create` and `task update` accept `--model <haiku|sonnet|opus>`; `task update --model default` clears it. Invalid values fail with a clear error. **[assistant's call]**
- `--model` on a task whose **effective** agent (card `agentId`, else runtime `selectedAgentId`) is not `claude` is an error. **[assistant's call]** Prevents a silent no-op.
- `task update --agent-id <other>` on a card that has `claudeModel` succeeds and keeps the field silently (§3). **[assistant's call]**
- `task list` output includes `claudeModel` when set.
- The sidebar system prompt CLI reference (`src/prompts/append-system-prompt.ts`) documents `--model` and says: use it only when the user names a Claude model; never pick Claude or a model on your own.

## 5. UI

- `TaskAgentModelPicker` (`web-ui/src/components/task-agent-model-picker.tsx`) already shows a model selector when the effective agent is `cline`. When the effective agent is `claude`, show a simple select instead: "Default (opus)" / haiku / sonnet / opus, where the default label reflects `claudeDefaultModel`. **[assistant's call]** Used by both `task-create-dialog.tsx` and `task-inline-create-card.tsx`.
- Editing the model of an existing backlog card works wherever the agent can be edited today. **[builder]** confirm where that is.

## 6. Session start

- `claudeAdapter.prepare` (`src/terminal/agent-session-adapters.ts:410`) appends `--model <effective model>` unless `hasCliOption(args, "--model")` is already true (`:112`). The effective model must reach the adapter the same way per-task Cline settings reach the Cline session (`src/trpc/runtime-api.ts:311-345`). **[builder]** exact plumbing.
- Resumes (`--continue`) also pass `--model` so a restarted task keeps its model.
- **Task sessions only.** The home/sidebar Claude session goes through the same adapter (home sessions are detected by `isHomeAgentSessionId`, `src/trpc/runtime-api.ts:~294`) and must get **no** `--model` from this feature, so the reviewer keeps following the user's `/model`. Add a test for it. **[assistant's call]**
- The session summary records the model it was launched with (new optional field, e.g. `claudeModel`, next to the session's `agentId` in `src/terminal/session-manager.ts:~334`). If the configured args already contain `--model <x>`, the recorded model is `<x>` when it is one of `haiku`/`sonnet`/`opus`, otherwise none. **[assistant's call]**

## 7. Scoring

- Score key: for a `claude` task, the score event's `agentId` is the model **the task's session was launched with** (the session summary field from §6), not the card's current value; for every other agent it stays the agent id. **[assistant's call]** This guarantees the first anti-goal: editing the card's model mid-task does not move points to a model that never ran. The new model applies from the next session start. Fallbacks: no session model recorded (e.g. sessions started before this change) → `card.claudeModel ?? claudeDefaultModel`; custom `--model` value that is not one of the three aliases → key `claude`. Written at record time, so the strip (`web-ui/src/components/agent-score-bar.tsx`), which prints `agentId` as-is, needs no change.
- Applies to every recording site: `assigned` in `recordTaskAssignment` (`src/trpc/runtime-api.ts:158-170`), `fail` on `task send` (`src/trpc/runtime-api.ts:~564`), `pass`/`fail` in `src/commands/task.ts:~346`, and the handoff fail in `src/trpc/app-router.ts:~569` (cannot be `claude` today, but use the same helper). One helper resolves the key from card + session + config. **[assistant's call]**
- Migration: `summarizeAgentScoreEvents` (`src/state/agent-scores.ts`) treats legacy events with `agentId === "claude"` as `opus`, and their `(agent, task)` de-duplication merges with real `opus` events. No rewrite of `agent-scores.json`. **[assistant's call]** Read-time mapping keeps the file append-only, as the scoreboard spec requires.
- Task history (`recordTaskHistoryEvent`) keeps `agentId: "claude"` (it names the agent, not the score bucket); new events may also carry the model, and legacy history is not rewritten. The Done history view showing `claude` while the strip shows `opus` is accepted. **[assistant's call]**

## 8. Tests (acceptance)

- Adapter: `claude` session args contain `--model haiku` when the card says haiku; `--model opus` when the card has no model and config default is opus; no duplicate when args already contain `--model`; the home/sidebar session gets no `--model`. (`test/runtime/terminal/agent-session-adapters.test.ts`)
- Scores: a card edited from haiku to sonnet after its session started still scores the next pass/fail as `haiku`.
- CLI: `task create --agent-id claude --model sonnet` stores `claudeModel: "sonnet"`; `task update --model default` clears it; `--model` with `--agent-id codex` fails; invalid value fails.
- Scores: assigning and passing a `claude` task with model haiku yields an entry `haiku` (+1, 1 task) and no `claude` entry; legacy `claude` events summarize as `opus` and merge with new `opus` events.
- UI: picker shows the Claude model select when agent is `claude` and hides it for other agents.
- `npm run typecheck`, `npm run lint`, `npm run test:fast` pass; web-ui tests for the picker pass.

## 9. Left to the builder
- Where the shared enum/helper lives; how the effective model is threaded from card to adapter; exact UI layout of the select; whether task history records the model.
