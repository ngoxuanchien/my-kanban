# Employee skill sets

Part 2 of 3 of the "agents as a company" upgrade. Part 1 (employee profiles, `docs/superpowers/specs/2026-11-06-employee-profiles-design.md`) is landed. Part 3 (manager finds work) comes later.

## Intent

Every task session loads every skill, plugin, and MCP server installed globally for its agent, and almost none of it is used. Measured on 2026-11-06:

- OpenCode loads 293 skills from `~/.config/opencode/skills` and 3 MCP servers. Across its whole history (`~/.local/share/opencode/opencode.db`, 9360 parts) the `skill` tool was called 5 times. MCP is used: playwright about 170 calls, `gh_grep` 31, context7 none.
- Codex has about 20 plugins enabled in `~/.codex/config.toml` (175 skills) plus 13 skills in `~/.agents/skills`. The last 30 Codex sessions never opened a `SKILL.md`.
- Claude, in Kanban task worktrees of this project over 30 days, used `superpowers:test-driven-development` (4) and `superpowers:systematic-debugging` (1). OpenCode and Antigravity do not have these skills installed at all.

The owner wants the skills Claude actually uses when implementing tasks to be the reference set for the other agents: every employee gets that set, plus anything its profile adds, and nothing else. This cuts the tokens spent on skill listings in every session and gives the other agents the working methods Claude uses.

## Goals

- **Reference set.** The skills Claude invoked (`Skill` tool calls) in Claude Code transcripts of this project's Kanban task worktrees, over the last 30 days. Transcripts live in `~/.claude/projects/<dir>/*.jsonl`; task worktree dirs are named `-Users-<user>--cline-worktrees-<taskId>-<repoName>`; only dirs whose repo name matches the current workspace's repo folder count. A skill counts after 1 use. Recomputed at task launch, cached for the runtime process for at most one hour. (Owner's choice: auto-updating, not a frozen list.) Because Claude now implements only on request, a 30-day window can hold no `Skill` call. Decision (spec author's call): the last non-empty set is persisted per workspace (next to `employees.json`, e.g. `reference-skills.json` with the names and the date computed) and used whenever the fresh scan is empty. The first run with nothing persisted and an empty scan seeds `test-driven-development`, `systematic-debugging` (the set measured on 2026-11-06).
- **Skill source.** For each reference skill, the skill folder (`SKILL.md` and its sibling files) is taken from Claude's installed copy: plugin skills from `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/` (highest installed version), user skills from `~/.claude/skills/<name>/`. A skill not found on disk is skipped with a warning.
- **Delivery.** At launch of a codex, opencode, or antigravity task session, Kanban copies the employee's skill set into the task worktree, where the agent discovers project skills:
  - Codex and Antigravity: `<worktree>/.agents/skills/<name>/`
  - OpenCode: `<worktree>/.opencode/skills/<name>/`
  - Both `.agents/skills/` and `.opencode/skills/` are added to the worktree's git `info/exclude` on every lean launch, for every agent. The Antigravity adapter's existing `.agents/` exclude (`src/terminal/agent-session-adapters.ts:761-781`) runs only when hooks are on (needs a workspace id); nothing excludes `.opencode/` today. Reuse that locked append logic, do not copy it.
  - The plugin prefix is stripped from the folder name (`superpowers:test-driven-development` → `test-driven-development`).
  - Kanban marks each folder it copies (a `.kanban-managed` file inside it). On every launch it removes managed folders that are not in the new employee's set, so after a handoff the next agent does not inherit the previous employee's extras. Folders without the marker (the repo's own skills) are never touched. Decision: spec author's call.
- **Global skills off, per session**, without touching global config files:
  - Codex: `-c` overrides that disable every enabled plugin (`plugins."<id>".enabled=false`) and every skill outside the employee set (`skills.config` entries with `enabled=false`, by name or path).
  - OpenCode: a `permission.skill` rule that denies every skill except the employee set, in a per-task config file. Today a per-task file is written only when the task has a model (`src/terminal/agent-session-adapters.ts:868-881`); otherwise `OPENCODE_CONFIG` points to the shared hook config (`:844-863`) used by every task. With lean sessions on, the adapter must always write a per-task file (plugin + optional model + permission + mcp), never put the rule in the shared file.
  - Antigravity: whatever the spike finds; if nothing works, its global skills stay on and only delivery applies.
- **MCP servers.** A server stays enabled for an employee if that agent used it at least once in the last 30 days (from that agent's transcripts / DB), or the profile enables it. All others are disabled for the session (Codex `mcp_servers.<name>.enabled=false`, OpenCode `mcp.<name>.enabled=false`).
- **MCP usage source.** Codex and Antigravity from their transcript files; OpenCode from `~/.local/share/opencode/opencode.db` (table `part`, tool parts) read-only via `node:sqlite` when the running Node has it (Node ≥ 22.5), else the `sqlite3` CLI. If usage cannot be read, that agent's MCP servers all stay enabled (fail open).
- **Profile extras.** `employees.json` entries (part 1) gain `skills: string[]` and `mcp: string[]` (extra names to enable; a skill name may end in `*` as a glob). Decision (spec author's call): extras on the plain agent key (`codex`, `opencode`, `antigravity`) apply to every employee of that agent; extras on a model key (`codex:gpt-6-luna`) add on top. At launch the key is the one `resolveScoreAgentKey` gives for the launching model; with no model, only the plain agent key applies. `employee set` gains `--skills` and `--mcp`. `employee show` adds the effective skill set, the effective MCP set, and per-skill / per-MCP use counts for that agent over 30 days.
- **Off switch.** A global runtime setting "Lean task sessions" (default on), next to `agentAutonomousModeEnabled` in `src/config/runtime-config.ts`, shown in the Settings dialog. Off: sessions launch exactly as today. Decision: spec author's call (global, not per project).

## Non-goals

- Claude task sessions. Claude is the reference; its sessions are unchanged.
- The sidebar (manager) session.
- Learning each agent's set from its own usage (measured near zero; the owner chose Claude's usage as the reference).
- Editing `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gemini`, or `~/.agents`.

## Anti-goals

- A task fails because a needed tool vanished. Built-in tools (shell, read, edit, web search) are never disabled; only skills, plugins, and MCP servers.
- Copied skill folders end up in a task commit.
- Launch gets slow: transcript scans are cached; launch adds at most a few hundred ms.

## Spike first

Before the implementation tasks, one spike task verifies on this machine, with evidence (command + output) recorded in `contexte/employee-skill-sets.md`:

1. Codex 0.166: the exact `-c` syntax that disables a plugin and a skill for one session, and that a skill in `<cwd>/.agents/skills/` is listed. Measure first-request input tokens of a trivial `codex exec` before and after.
2. OpenCode 2.2.5: a `permission.skill` deny-all-but-list rule in an `OPENCODE_CONFIG` file hides the other 293 skills; a skill in `<cwd>/.opencode/skills/` is listed; `mcp.<name>.enabled=false` disables a server. Measure tokens the same way.
3. Antigravity 1.5.0: whether it reads `<cwd>/.agents/skills/`, and any per-session way to disable global skills or MCP servers.

If a mechanism does not work, the spike says so and the implementation drops that part for that agent. The spike changes no product code.

## Constraints

- Runtime git calls use `runGit` (`src/workspace/git-utils.ts`), never raw `execFile("git")` (lesson from part 1).
- Tests that spawn git use `createGitTestEnv()`. Tests that launch agent adapters stub `HOME` (see `contexte/difficulty-model-selection.md`).
- New card or state fields follow the threading rule in `AGENTS.md`.

## Left to the builder

- Transcript parsing details and the cache.
- How the Codex `-c` overrides are built from the installed plugin list (read `~/.codex/config.toml` read-only).
- Whether copied skill folders are refreshed on every launch or only when missing.
