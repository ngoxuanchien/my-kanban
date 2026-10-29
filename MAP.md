# Project map

Update this file whenever a file or folder is created or moved.

## Where to find things
| Path | Contents |
|---|---|
| `CLAUDE.md` | Project goal and rules. Imports `AGENTS.md` and this file. |
| `CLAUDE.local.md` | Personal preferences: language, reporting, agent assignment, git policy (local only). |
| `.gitignore` | Also ignores local-only harness files so Kanban symlinks them into task worktrees. |
| `.env` | Secrets only (git-ignored). Create when the first secret is needed, with a matching `.env.example`. |
| `AGENTS.md` | Engineering conventions and tribal knowledge (TypeScript, web-ui stack, design tokens). |
| `src/` | Runtime (Node/TS): `cli.ts` entry, `server/`, `trpc/`, `cline-sdk/`, `terminal/`, `workspace/`, `state/`, `projects/`, `prompts/`. |
| `web-ui/` | React + Tailwind v4 frontend (`web-ui/src/`). |
| `packages/desktop/` | Desktop (Electron) app. |
| `test/` | Runtime tests (`runtime/`, `integration/`, `utilities/`). |
| `scripts/` | Build / dev / dogfood scripts. |
| `docs/` | Public docs: `architecture.md`, `smoke-tests/`. |
| `docs/superpowers/specs/` | Design specs (`YYYY-MM-DD-<topic>-design.md`). |
| `docs/superpowers/plans/` | Implementation plans (`YYYY-MM-DD-<topic>.md`). |
| `docs/superpowers/specs/2026-10-28-agent-review-design.md` | Superseded (removed 2026-10-29). |
| `docs/superpowers/specs/2026-10-28-agent-review-live-terminal-design.md` | Superseded (removed 2026-10-29). |
| `docs/superpowers/plans/2026-10-28-agent-review.md` | Superseded (removed 2026-10-29). |
| `docs/superpowers/plans/2026-10-28-agent-review-live-terminal.md` | Superseded (removed 2026-10-29). |
| `docs/superpowers/specs/2026-10-28-memory-orchestrator-design.md` | Spec: shared Basic Memory server, OpenCode/Codex split, cross review. |
| `docs/superpowers/specs/2026-10-29-remove-agent-review-design.md` | Spec: remove the automatic reviewer and restore the four-column Review board. |
| `docs/superpowers/specs/2026-10-29-sidebar-agent-review-design.md` | Spec: sidebar agent reviews tasks, `task send`, up to 3 fix rounds. |
| `docs/superpowers/plans/2026-10-29-sidebar-agent-review.md` | Plan for the sidebar agent review spec, split into 3 Kanban tasks. |
| `docs/superpowers/plans/2026-10-28-memory-orchestrator.md` | Plan for the spec above, split into Kanban tasks. |
| `docs/agents/task-prompt-template.md` | Prompt template the planner fills in for every Kanban task. |
| `.plan/` | Older internal plans, handoffs, investigations (`.plan/docs/`). |

## Where to save things
| What | Where | In git? |
|---|---|---|
| Durable knowledge: decisions, preferences, findings (one file per topic) | `contexte/` | No (local) |
| Anything produced for me (reports, analyses, proposals) | `livrables/` | No (local) |
| Personal preferences | `CLAUDE.local.md` | No (local) |
| Secrets | `.env` only | No (local) |
| Specs / plans for code changes | `docs/superpowers/specs/`, `docs/superpowers/plans/` | Yes |

## contexte/
| File | Topic |
|---|---|
| `contexte/project-goal.md` | Token-reduction + shared-context goal for Claude Code / OpenCode / Codex. |
| `contexte/local-only-folders.md` | Which files are local-only, how (`.gitignore`), and the no-push git policy. |
| `contexte/parallel-sessions.md` | Rule for running agent sessions in parallel without file conflicts. |
| `contexte/memory-orchestrator.md` | Decisions + measured token findings for shared memory (Basic Memory) and agent orchestration. |
| `contexte/agent-review-live-terminal.md` | Superseded: reviewer ran as a live PTY session; verdict-file design and its gotchas. |

## livrables/
_(empty)_
