# Employee Skill Sets Implementation Plan

> **For agentic workers:** Each task below is one Kanban task in its own worktree. Steps use checkbox (`- [ ]`) syntax. Do not commit; the sidebar reviewer commits on pass.

**Goal:** Codex/OpenCode/Antigravity task sessions get only the skills Claude used in this project's task worktrees (plus profile extras), copied into the worktree; global skills, plugins and unused MCP servers are off for the session.

**Architecture:** `src/state/` computes the reference set (Claude transcripts, persisted fallback), per-agent tool usage (MCP), and the effective set per employee. `src/trpc/runtime-api.ts` (the one place that builds a task launch, line ~528) resolves the effective set and passes it in the launch input; `src/terminal/` copies skill folders into the worktree and turns the rest off per agent. The CLI and Settings show and control it.

**Tech Stack:** TypeScript, Node (`node:sqlite` when present, else `sqlite3` CLI), commander, React + Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-11-06-employee-skill-sets-design.md`

## Global Constraints

- Never write `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.gemini`, `~/.agents`; reading is fine.
- Claude task sessions and the sidebar session are unchanged.
- Built-in tools are never disabled; only skills, plugins, MCP servers.
- Runtime git calls use `runGit` (`src/workspace/git-utils.ts`). Tests that spawn git use `createGitTestEnv()`. Tests touching adapters or `~` paths stub `HOME`.
- Copied folders carry a `.kanban-managed` marker; folders without it are never removed.
- `.agents/skills/` and `.opencode/skills/` are in the worktree's `info/exclude` on every lean launch.
- Setting `leanTaskSessionsEnabled` is global, default `true`; `false` = launch exactly as today.
- Acceptance for every code task: `npm run typecheck`, `npm run lint`, `npm run test:fast`, `npm run web:typecheck`, `npm --prefix web-ui run test`, `npm run web:build`.

## Review Focus

1. Reference scan finds no `Skill` call → persisted last set is used; nothing persisted → seed `test-driven-development`, `systematic-debugging`. Test in Task 1.
2. A reference skill not installed under `~/.claude` → skipped with a warning, launch continues. Test in Task 1.
3. Handoff codex → opencode in the same worktree with a different set → managed folders not in the new set are removed; an unmarked repo skill folder survives. Test in Task 2.
4. OpenCode task with no model → a per-task config file is still written and the shared hook config is untouched. Test in Task 2.
5. `opencode.db` unreadable → all OpenCode MCP servers stay enabled. Test in Task 1.

---

### Task 0: Spike — per-session skill/MCP control in each CLI

**Files:** `contexte/employee-skill-sets.md` only (local, not committed). No product code.

Verify on this machine and record each command with its output:
- [ ] Codex 0.166: `-c` syntax that disables one plugin and one skill for a single run (`plugins."<id>".enabled=false`, `skills.config=[{name="<n>",enabled=false}]` or the working form); a skill placed in `<tmp repo>/.agents/skills/<n>/SKILL.md` is listed; `mcp_servers.<name>.enabled=false` works. Measure first-request input tokens of `codex exec "say ok"` with and without the overrides (from the rollout `token_count` event).
- [ ] OpenCode 2.2.5: an `OPENCODE_CONFIG` file with `permission.skill` `{ "*": "deny", "<n>": "allow" }` hides the global skills; `<tmp repo>/.opencode/skills/<n>/` is listed; `mcp.<name>.enabled=false` works. Measure tokens (`opencode stats` or the DB `part` token fields).
- [ ] Antigravity 1.5.0: does it read `<cwd>/.agents/skills/`? Any per-session way to disable global skills / MCP (env, flag, `.agents/` config)?
- [ ] For each, write the exact working form, or "not possible" with what was tried.

Acceptance: the note exists with the items above, each backed by pasted command output. `git status` in the worktree shows no product file changed.

### Task 1: Reference set, tool usage, effective set (state)

**Files:**
- Create: `src/state/reference-skills.ts`, `src/state/agent-tool-usage.ts`, `src/core/employee-skill-set.ts`
- Modify: `src/state/employees.ts` (`DeclaredEmployee` gains `skills: string[]`, `mcp: string[]`; parse and keep like `strong`)
- Test: `test/runtime/state/reference-skills.test.ts`, `test/runtime/state/agent-tool-usage.test.ts`, `test/runtime/core/employee-skill-set.test.ts`, extend `test/runtime/state/employees.test.ts`

**Interfaces (produces):**
- `reference-skills.ts`:
  - `interface SkillSource { name: string; dir: string }` (`name` without plugin prefix; `dir` absolute folder containing `SKILL.md`)
  - `scanClaudeTaskSkillUsage(input: { home: string; repoName: string; sinceMs: number }): Promise<Map<string, number>>` — reads `<home>/.claude/projects/*-cline-worktrees-<id>-<repoName>/*.jsonl` (modified since `sinceMs`), counts `tool_use` blocks with `name === "Skill"` by `input.skill`.
  - `loadReferenceSkills(input: { workspaceId: string; home: string; repoName: string; now: number }): Promise<string[]>` — 30-day scan; non-empty → persist `reference-skills.json` `{ version: 1, skills: string[], computedAt: number }` in `getWorkspaceDirectoryPath(workspaceId)` and return; empty → persisted list, else `["superpowers:test-driven-development", "superpowers:systematic-debugging"]`. In-memory cache per workspace, 1 hour.
  - `resolveSkillSources(home: string, names: string[]): Promise<SkillSource[]>` — `plugin:name` → highest version dir under `<home>/.claude/plugins/cache/*/<plugin>/*/skills/<name>/`; bare `name` → `<home>/.claude/skills/<name>/`; missing → warn and skip.
- `agent-tool-usage.ts`:
  - `loadAgentMcpUsage(input: { agentId: "codex" | "opencode" | "antigravity"; home: string; sinceMs: number }): Promise<Map<string, number> | null>` — calls per MCP server name. Codex: rollout jsonl under `<home>/.codex/sessions`; OpenCode: `<home>/.local/share/opencode/opencode.db` table `part`, tool parts, server = configured MCP name that prefixes the tool name (server names from `<home>/.config/opencode/opencode.jsonc`); Antigravity: per Task 0, else `null`. `null` = unknown (fail open).
  - `loadAgentSkillUsage(...)`: same shape for skills, used only by `employee show`.
- `employee-skill-set.ts`:
  - `interface EffectiveSkillSet { skills: SkillSource[]; mcpEnabled: string[] | null }` (`null` = leave all MCP on)
  - `resolveEffectiveSkillSet(input: { agentId: string; model: string | null; declared: Record<string, DeclaredEmployee>; reference: string[]; mcpUsage: Map<string, number> | null; home: string }): Promise<EffectiveSkillSet>` — skills = reference ∪ extras of the plain agent key ∪ extras of the `resolveScoreAgentKey` key (trailing `*` globbed against installed Claude skill names); MCP = used ∪ extras, or `null` when usage is `null`.

- [ ] **Step 1:** Tests with a fake `home`: transcripts in `-Users-x--cline-worktrees-ab123-my-kanban` count, `...-other-repo` do not; files older than 30 days ignored; empty scan + persisted → persisted; empty + nothing → seed; missing skill dir → skipped + warn; plugin versions `6.4.1` and `7.0.0` → `7.0.0`; extras on `codex` apply to `codex:gpt-6-luna`; extras on `codex:gpt-6-luna` do not apply to `codex:gpt-6.1-sol`; unreadable db → `null`; codex rollout with two `mcp__playwright__*` calls → `playwright: 2`.
- [ ] **Step 2:** Run the new tests — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; full acceptance list.

### Task 2: Lean launch (runtime + adapters + setting)

**Files:**
- Create: `src/terminal/task-skill-delivery.ts`
- Modify: `src/config/runtime-config.ts` (global `leanTaskSessionsEnabled`, default true, next to `agentAutonomousModeEnabled` at lines 22/41/56/302), `src/core/api-contract.ts` (config schemas next to lines 1089/1112), `src/trpc/runtime-api.ts:~528` (resolve and pass the set), `src/terminal/session-manager.ts:86,349` (thread the field), `src/terminal/agent-session-adapters.ts` (codex ~590-625, antigravity ~750-800, opencode ~820-890)
- Test: `test/runtime/terminal/task-skill-delivery.test.ts`, the existing adapter tests under `test/runtime/terminal/`, the runtime-config test under `test/runtime/config/`

**Interfaces:** Consumes Task 1. Produces:
- `AgentAdapterLaunchInput.leanSkillSet?: EffectiveSkillSet` (absent = today's behavior; set only for codex/opencode/antigravity when the setting is on).
- `deliverTaskSkills(input: { cwd: string; agentId: "codex" | "opencode" | "antigravity"; skills: SkillSource[] }): Promise<void>` — target `.agents/skills` (codex, antigravity) or `.opencode/skills` (opencode); copy each folder (`fs.cp` recursive) and write `.kanban-managed`; remove managed folders not in `skills` from both targets; add `.agents/skills/` and `.opencode/skills/` to `info/exclude` with the same locked append the antigravity adapter uses (extract it into this module and call it from both places).
- Codex (forms proven by the Task 0 spike, `contexte/employee-skill-sets.md`): `-c plugins.<id>.enabled=false` with a BARE key (the quoted form `plugins."<id>"` is silently ignored) for every id that `codex plugin list` reports "installed, enabled" (includes remote plugins absent from `config.toml`); `-c skills.bundled.enabled=false`; `-c 'skills.config=[{name="<n>",enabled=false},...]'` for every catalog name not in the set (catalog from `codex debug prompt-input`, which also covers `~/.agents/skills`); `-c mcp_servers.<n>.enabled=false` for config-declared servers not in `mcpEnabled` (when non-null). Cache the plugin list and catalog per runtime process (they cost a CLI call each).
- OpenCode: when `leanSkillSet` is set, always write the per-task config (`<runtime home>/hooks/opencode/tasks/<taskId>-<uuid>.json`, removed by `cleanup`) with `plugin` (if hooks), `model` (if any), `permission.skill` `{ "*": "deny", "<each name>": "allow" }`, and for each disabled server its FULL definition copied from `opencode.jsonc` plus `"enabled": false` (an entry with only `enabled` is silently dropped, per the spike). The shared hook config is never modified.
- Antigravity: delivery only (spike: no per-session skill/MCP switch; global `~/.agents/skills` is not loaded by agy 1.5.0).

- [ ] **Step 1:** Tests: delivery copies and marks; a second call with a smaller set removes the managed extra and keeps an unmarked folder; exclude lines present once after two calls; codex args contain the plugin-off overrides for a fake `config.toml`; opencode without model writes a per-task file containing `permission.skill` and leaves the shared file byte-identical; `leanSkillSet` absent → args/env identical to today; setting `false` → runtime-api passes no `leanSkillSet`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; full acceptance list.

### Task 3: CLI and Settings

**Files:**
- Modify: `src/commands/employee.ts` (`set --skills a,b --mcp a,b`; `show` adds `effectiveSkills`, `effectiveMcp`, `skillUsage`, `mcpUsage`), `src/prompts/append-system-prompt.ts` (employee section: the two new flags), `web-ui/src/components/runtime-settings-dialog.tsx` (toggle "Lean task sessions" with a one-line hint) and the web-ui save path for the config field
- Test: `test/runtime/employee-command.test.ts`, `test/runtime/append-system-prompt.test.ts`, `web-ui/src/components/runtime-settings-dialog.test.tsx`

**Interfaces:** Consumes Task 1 (`resolveEffectiveSkillSet`, usage loaders) and Task 2's config field `leanTaskSessionsEnabled`.

- [ ] **Step 1:** Tests: `set --employee codex --skills superpowers:verification-before-completion` then `show --employee codex:gpt-6-luna` lists it in `effectiveSkills`; settings toggle saves `leanTaskSessionsEnabled: false` through the real save path (check the App/hook wiring, not only the component).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; full acceptance list.

## Task order

Task 0 → Task 1 → Task 2 → Task 3. Task 2 reads Task 0's note; Task 3 needs Task 2's config field.
