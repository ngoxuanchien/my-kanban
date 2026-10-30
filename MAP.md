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
| `docs/superpowers/specs/2026-10-28-memory-orchestrator-design.md` | Spec: shared Basic Memory server, OpenCode/Codex split, sidebar agent review (cross review dropped). |
| `docs/superpowers/specs/2026-10-29-remove-agent-review-design.md` | Spec: remove the automatic reviewer and restore the four-column Review board. |
| `docs/superpowers/specs/2026-10-29-sidebar-agent-review-design.md` | Spec: sidebar agent reviews tasks, `task send`, up to 3 fix rounds. |
| `docs/superpowers/plans/2026-10-29-sidebar-agent-review.md` | Plan for the sidebar agent review spec, split into 3 Kanban tasks. |
| `docs/superpowers/specs/2026-10-29-empty-task-nudge-design.md` | Spec: runtime nudges a task agent once when its worktree is empty instead of waking the sidebar reviewer. |
| `docs/superpowers/plans/2026-10-29-empty-task-nudge.md` | Plan for the empty-task nudge spec. |
| `docs/superpowers/specs/2026-10-29-agent-handoff-design.md` | Spec: hand a stuck review-enabled task once from Codex to OpenCode (or back), up to 6 review rounds. |
| `docs/superpowers/plans/2026-10-29-agent-handoff.md` | Plan for the agent handoff spec, split into 3 chained Kanban tasks. |
| `docs/superpowers/specs/2026-10-29-quota-handoff-design.md` | Spec: hand off at once when the task terminal shows a usage-limit message. |
| `docs/superpowers/specs/2026-10-29-quota-retry-and-review-notes-design.md` | Spec: agy quota phrases, "Out of quota" card label + hourly retry, sidebar writes review lessons to `contexte/`. |
| `docs/superpowers/plans/2026-10-29-quota-retry-and-review-notes.md` | Plan for the quota retry and review notes spec, split into 4 Kanban tasks. |
| `docs/superpowers/specs/2026-10-29-agent-scoreboard-design.md` | Spec: per-agent score (+1 pass, −1 fail) and assigned-task count on the top bar. |
| `docs/superpowers/plans/2026-10-29-agent-scoreboard.md` | Plan for the agent scoreboard spec, split into 3 Kanban tasks. |
| `docs/superpowers/specs/2026-10-29-done-task-history-design.md` | Spec: clickable Done cards with a read-only history timeline, commit diff, and agent transcript viewer. |
| `docs/superpowers/plans/2026-10-29-done-task-history.md` | Plan for the Done task history spec, split into 3 chained Kanban tasks. |
| `docs/superpowers/plans/2026-10-29-quota-handoff.md` | Plan for the quota handoff spec (1 Kanban task). |
| `docs/superpowers/specs/2026-10-29-quota-continue-nudge-design.md` | Spec: send `continue` once to a stuck agent before quota handoff / Out of quota. |
| `docs/superpowers/plans/2026-10-29-quota-continue-nudge.md` | Plan for the quota continue nudge spec (1 Kanban task). |
| `docs/superpowers/specs/2026-10-29-review-on-by-default-design.md` | Spec: agent review on by default for new tasks; enabling it on a finished task starts a review. |
| `docs/superpowers/specs/2026-10-29-card-review-label-design.md` | Spec: show review state (Review n/3, Handed off) on the card's agent line. |
| `docs/superpowers/specs/2026-10-29-antigravity-agent-design.md` | Spec: Antigravity (`agy`) as a third task agent; handoff chain over codex/opencode/antigravity, up to 9 review rounds. |
| `docs/superpowers/plans/2026-10-29-antigravity-agent.md` | Plan for the Antigravity agent spec, split into 2 chained Kanban tasks. |
| `docs/superpowers/plans/2026-10-28-memory-orchestrator.md` | Plan for the spec above, split into Kanban tasks. |
| `docs/superpowers/specs/2026-10-30-sidebar-default-task-agent-design.md` | Spec: sidebar always passes `--agent-id` from the handoff cycle (codex/opencode/antigravity) unless the user names an agent. |
| `docs/superpowers/plans/2026-10-30-sidebar-default-task-agent.md` | Plan for the sidebar default task agent spec (1 Kanban task). |
| `docs/superpowers/specs/2026-10-30-ui-contrast-and-history-polish-design.md` | Spec: impeccable audit findings — raise text tokens, Done card/board fixes, Done history view polish; false positives recorded. |
| `docs/superpowers/plans/2026-10-30-ui-contrast-and-history-polish.md` | Plan for the UI polish spec, split into 2 parallel Kanban tasks. |
| `docs/superpowers/specs/2026-10-30-agent-score-bottom-bar-design.md` | Spec: move the agent score strip from the top bar to a slim bottom status bar. |
| `docs/superpowers/plans/2026-10-30-agent-score-bottom-bar.md` | Plan for the agent score bottom bar spec (1 Kanban task). |
| `docs/superpowers/specs/2026-10-30-upstream-issue-fixes-design.md` | Spec: fix upstream #665 (stalled terminal viewer), #674 (lost board writes), #623 + #128 (CLI stdout cut at 64 KiB, lock crash); #619 dropped. |
| `docs/superpowers/plans/2026-10-30-upstream-issue-fixes.md` | Plan for the upstream issue fixes spec, split into 3 parallel Kanban tasks. |
| `docs/superpowers/specs/2026-10-30-done-history-layout-design.md` | Spec: Done history drops its duplicate Back bar; left column, timeline/diff split and transcript drawer become resizable. |
| `docs/superpowers/plans/2026-10-30-done-history-layout.md` | Plan for the Done history layout spec (1 Kanban task). |
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
| `contexte/opencode-multi-account.md` | Zen free limit is per IP, not per account; multi-account routers tried and removed. |
| `contexte/antigravity-agent.md` | Antigravity CLI hook spike findings and adapter behavior. |
| `contexte/agent-transcripts.md` | Transcript formats, normalized readers, and session capture limits. |
| `contexte/upstream-issues.md` | Which open cline/kanban issues affect this fork, what was fixed, and what was left. |

## livrables/
_(empty)_
