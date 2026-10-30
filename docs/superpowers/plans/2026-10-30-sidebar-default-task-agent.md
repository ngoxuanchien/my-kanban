# Plan: sidebar picks a handoff-cycle agent for new tasks

Spec: `docs/superpowers/specs/2026-10-30-sidebar-default-task-agent-design.md`

One Kanban task (Codex, agent review on).

## Task 1: Workflow Notes rule for `--agent-id`
Files: `src/prompts/append-system-prompt.ts`, `test/runtime/append-system-prompt.test.ts`.

1. Write the failing test: render the sidebar prompt, take the `# Workflow Notes` section, assert it contains `--agent-id`, the `HAND_OFF_CYCLE` agents joined in order, and the phrase that other agents are used only when the user asks.
2. Add the bullet to `# Workflow Notes`, importing `HAND_OFF_CYCLE` from `../core/hand-off-cap`. Wording:
   `- When creating a task and the user did not name an agent, always pass \`--agent-id\`. Rotate through ${cycle} in that order, starting after the agent of the most recently created task in \`task list\` (start with ${first} if none uses one of them). Use any other agent, such as claude or cline, only when the user asks for it, because only these agents can be handed off when a task gets stuck.`
3. Verify: `npm run typecheck`, `npm run lint`, `npm run test:fast`.
