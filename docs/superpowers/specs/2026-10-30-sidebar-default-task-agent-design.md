# Sidebar picks a handoff-cycle agent for new tasks

Date: 2026-10-30
Status: approved (user chose option A, 2026-10-30)

## 1. Problem
In projects other than my-kanban, the sidebar agent creates tasks without `--agent-id`. The task then runs on `selectedAgentId` from `~/.cline/kanban/config.json`, which is `claude` because the same setting picks the sidebar agent (`src/server/sidebar-review-service.ts:432`). Claude tasks cannot be handed off (`src/core/hand-off-cap.ts:3`, `src/server/hand-off-task.ts:54`), so a stuck task stops at round 3/3 (seen on task fe990 in another project).

The rule "implementation goes to Codex/OpenCode" lives only in my-kanban's `CLAUDE.md` (rule 10), `CLAUDE.local.md`, and per-project Claude memory, so other projects never see it.

## 2. Goal
- G1. Whenever the sidebar creates a task and the user did not name an agent, it passes `--agent-id` with an agent from the handoff cycle (`codex`, `opencode`, `antigravity`). **[user]**
- G2. It rotates through the cycle in order, starting after the agent of the most recently created task in `task list`; if none of the listed tasks uses a cycle agent, it starts with `codex`. **[assistant's call]**
- G3. It uses `claude`, `cline`, or another agent only when the user asks for it. **[user]**
- G4. Works in every project, because the rule lives in the sidebar system prompt.

## 3. Non-goals
- A new runtime config field for a default task agent separate from the sidebar agent.
- Changing `selectedAgentId`, `task create` defaults, or handoff logic.

## 4. Design
- `src/prompts/append-system-prompt.ts`, section `# Workflow Notes`: add one bullet stating G1–G3. Build the agent list from `HAND_OFF_CYCLE` (`src/core/hand-off-cap.ts`) so the text follows the cycle if it changes.
- Test in `test/runtime/append-system-prompt.test.ts`: the rendered prompt's Workflow Notes section contains `--agent-id`, each `HAND_OFF_CYCLE` agent in order, and says other agents are used only when the user asks.

## 5. Risks
- The rule is a prompt instruction, not enforced; an agent could ignore it. Accepted: enforcement would need the separate config field listed as a non-goal.
