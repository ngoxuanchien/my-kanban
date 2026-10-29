@AGENTS.md
@MAP.md

# Working profile
Personal preferences (language, reporting, agent assignment, git) live in `CLAUDE.local.md`.

## What this project is for
This fork of Kanban (multi-agent coding board) is the base for one goal:
**reduce token usage and share context between coding agents on my Mac** — Claude Code, OpenCode, Codex.
- Priority: balance token savings with context retention.
- Storage: one centralized memory server.
- Automation: an orchestrator that picks the model, runs the agent, and verifies the result.
Details and decisions: `contexte/project-goal.md`.

## Rules
1. At the start of every conversation, read `CLAUDE.md` and `MAP.md` before answering (both are auto-loaded via this file).
2. Record every important decision or finding in `contexte/` — one file per topic. Update the existing file instead of creating duplicates.
3. Everything produced for me (reports, analyses, designs not tied to the codebase) goes in `livrables/`.
4. Create other folders (sources, scripts, docs) only when needed, and update `MAP.md` whenever a file is created or moved.
5. Every new feature/change: superpowers workflow (brainstorming → spec → plan) before code. Specs in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`.
6. Secrets (passwords, API keys, tokens) live only in `.env` (git-ignored). Never write them anywhere else; document variable names in `.env.example`.
7. Ask before changing global agent config outside the repo (`~/.claude`, `~/.codex`, `~/.config/opencode`).
8. Before claiming "done", run the relevant typecheck, tests, and lint, and include the output as evidence.
9. Parallel sessions: one task = one Kanban task worktree = one branch. Never run two agents in the main checkout. See `contexte/parallel-sessions.md`.
10. When creating Kanban tasks from a plan: alternate --agent-id opencode/codex/antigravity, and fill docs/agents/task-prompt-template.md (copy needed context from memory into the prompt).
