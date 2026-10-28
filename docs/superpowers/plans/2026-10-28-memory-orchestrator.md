# Memory + Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `"cross"` reviewer setting (Codex ↔ OpenCode). Add the docs and ignore rules that let Claude and OpenCode share one Basic Memory server over `contexte/`. Then roll that server out.

**Architecture:** Kanban keeps running tasks and reviews. It gains one reviewer-resolution rule (pure function plus schema value plus a UI option). Memory is an external Basic Memory process (streamable HTTP on `127.0.0.1:8765/mcp`, launchd), registered through gitignored repo files that Kanban symlinks into every task worktree. Codex is not connected to it. The planner passes context to all agents through a task prompt template.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), zod, vitest, React + Tailwind v4 (`web-ui`), Basic Memory (Python, via `uv tool`), macOS launchd.

**Spec:** `docs/superpowers/specs/2026-10-28-memory-orchestrator-design.md`

## How to run this plan on the board

| Task | Kanban task? | Agent (`--agent-id`) | Reviewer | Depends on | Runs in parallel with |
|---|---|---|---|---|---|
| 1. Cross reviewer: runtime | yes | `opencode` | current `reviewerAgent` setting | — | 3 |
| 2. Cross reviewer: settings UI | yes | `codex` | current `reviewerAgent` setting | 1 (merged) | 3 |
| 3. Agent docs + ignore rules | yes | `codex` | current `reviewerAgent` setting | — | 1, 2 |
| 4. Basic Memory rollout | **no**: user + Claude in the main checkout, with approvals | — | user | 3 (merged), and no task running | — |
| 5. Switch on cross review | **no**: one setting | — | — | 2 (merged) | — |

- Create every Kanban task with `--agent-review-enabled` (saved preference).
- Agents alternate per the spec (4.3). Task 3 is assigned to `codex` rather than `opencode` so that both agents get one code task and Codex also gets the docs task.
- **File ownership (no overlaps):**
  - Task 1 owns `src/core/api-contract.ts`, `src/agent-review/reviewer-agent.ts`, `src/agent-review/agent-review-service.ts`, `test/runtime/agent-review/reviewer-agent.test.ts`, `test/runtime/agent-review/agent-review-service.test.ts` and `test/runtime/config/runtime-config.test.ts`.
  - Task 2 owns `web-ui/src/components/runtime-settings-dialog.tsx` and `web-ui/src/components/runtime-settings-dialog.test.tsx`.
  - Task 3 owns `AGENTS.md`, `CLAUDE.md`, `MAP.md`, `.gitignore` and `docs/agents/task-prompt-template.md`.
- **Before creating tasks:** the spec, this plan, and the `MAP.md` entries for them must be committed on the base branch. Otherwise Task 3's worktree starts without them and its `MAP.md` edit will conflict. Commit only when the user asks.
- Paste each task section below into the task prompt using `docs/agents/task-prompt-template.md`. For Tasks 1 and 3, which run before that file exists, use the template text in spec §4.4.

## Global Constraints

- Reviewer setting values: `"same_as_task" | "cross" | RuntimeAgentId`. Default stays `"same_as_task"`, and the default is still not written to disk.
- `"cross"` mapping: task agent `opencode` → `codex`; `codex` → `opencode`; anything else → the task agent itself. The task agent is `card.agentId ?? config.selectedAgentId` (existing rule).
- No fallback to Claude when the cross reviewer is missing or fails. The existing agent-review failure paths apply.
- Memory server URL: `http://127.0.0.1:8765/mcp`. Basic Memory project name: `my-kanban`. Folder: `/Users/xuanchien/Project/claude-app/my-kanban/contexte`.
- Codex gets **no** memory server config.
- No change to global agent config (`~/.claude`, `~/.codex`, `~/.config/opencode`) or to `~/Library/LaunchAgents` without the user approving that exact change.
- No secrets anywhere. None are needed.
- Before claiming a task done, run `npm run typecheck`, `npm run lint`, `npm run test:fast` (plus `npm run web:typecheck` and `npm run web:test` for Task 2) and paste the output.
- Never push. Commit locally only when the user asks.

## Review Focus

1. A saved global config with `reviewerAgent: "cross"` must load as `"cross"` and must not silently fall back to `"same_as_task"`. The schema change must be applied inside `normalizeReviewerAgent`. Test: Task 1, Step 5.
2. A card with no `agentId`, while the selected agent is `opencode`, is reviewed by `codex`. Test: Task 1, Step 6.
3. Cross mode on a `claude`, `cline` or other non-pair task reviews with that same agent and must not error. Test: Task 1, Step 1.
4. The settings dialog shows **Cross (Codex ↔ OpenCode)** as selected when the loaded config is `"cross"`, so reopening the dialog does not reset it. Test: Task 2, Step 1.
5. Basic Memory must never rewrite or delete note content in `contexte/`. Check: Task 4, Step 2 (copy test, stop on any non-frontmatter change).

---

### Task 1: Cross reviewer, runtime

**Files:**
- Modify: `src/core/api-contract.ts:1032` (`runtimeReviewerAgentSettingSchema`)
- Create: `src/agent-review/reviewer-agent.ts`
- Modify: `src/agent-review/agent-review-service.ts:571-574` (use the new resolver)
- Test: `test/runtime/agent-review/reviewer-agent.test.ts` (new), `test/runtime/config/runtime-config.test.ts`, `test/runtime/agent-review/agent-review-service.test.ts`

**Interfaces:**
- Produces: `RuntimeReviewerAgentSetting` now includes `"cross"`. Task 2 relies on this.
- Produces: `resolveReviewerAgentId(setting: RuntimeReviewerAgentSetting, taskAgentId: RuntimeAgentId): RuntimeAgentId`, exported from `src/agent-review/reviewer-agent.ts`.

- [ ] **Step 1: Write the failing unit test** `test/runtime/agent-review/reviewer-agent.test.ts`

```ts
describe("resolveReviewerAgentId", () => {
	it("same_as_task returns the task agent", () => {
		expect(resolveReviewerAgentId("same_as_task", "opencode")).toBe("opencode");
	});
	it("a fixed agent wins regardless of task agent", () => {
		expect(resolveReviewerAgentId("claude", "codex")).toBe("claude");
	});
	it("cross maps opencode → codex and codex → opencode", () => {
		expect(resolveReviewerAgentId("cross", "opencode")).toBe("codex");
		expect(resolveReviewerAgentId("cross", "codex")).toBe("opencode");
	});
	it("cross keeps other agents unchanged", () => {
		for (const agent of ["claude", "cline", "gemini", "droid", "kiro"] as const) {
			expect(resolveReviewerAgentId("cross", agent)).toBe(agent);
		}
	});
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run test/runtime/agent-review/reviewer-agent.test.ts`
Expected: FAIL, module `src/agent-review/reviewer-agent` not found.

- [ ] **Step 3: Implement**
  - Change the schema to `z.union([z.literal("same_as_task"), z.literal("cross"), runtimeAgentIdSchema])`.
  - Add `resolveReviewerAgentId` in `src/agent-review/reviewer-agent.ts`, with the mapping kept as a small const record `{ opencode: "codex", codex: "opencode" }`.
  - In `agent-review-service.ts`, replace the inline ternary at `:572-573` with `resolveReviewerAgentId(config.reviewerAgent, resolveTaskAgentId(card, config))`.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run test/runtime/agent-review/reviewer-agent.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Config round-trip test** in `test/runtime/config/runtime-config.test.ts`

Add `it("saves and reloads reviewerAgent = cross")`, a copy of the existing `"saves and reloads reviewerAgent = codex"` test (`:469`) with `"cross"`. It asserts that `updated.reviewerAgent` and the global payload's `reviewerAgent` both equal `"cross"`.

Run: `npx vitest run test/runtime/config/runtime-config.test.ts`
Expected: PASS.

- [ ] **Step 6: Service test** in `test/runtime/agent-review/agent-review-service.test.ts`

Add `it("cross reviewer reviews an opencode task with codex")`:
- `configOverrides = { reviewerAgent: "cross" }`;
- card `"A"` created with `agentId: "opencode"`;
- after `emit(turnEnd("A"))`, assert `service?.getReviewerLog("A")` matches `{ reviewerAgentId: "codex" }`.

Add `it("cross reviewer uses the selected agent when the card has none")`: the card has no `agentId` and `selectedAgentId` is `"opencode"`, so it also expects `"codex"`. Use the existing reviewer-stub pattern (`reviewerScripts`, `:455-480`).

Run: `npx vitest run test/runtime/agent-review/agent-review-service.test.ts`
Expected: PASS.

- [ ] **Step 7: Full checks**

Run: `npm run typecheck && npm run lint && npm run test:fast`
Expected: all exit 0.

- [ ] **Step 8: Commit (only when the user asks)**

```bash
git add src/core/api-contract.ts src/agent-review/reviewer-agent.ts src/agent-review/agent-review-service.ts test/runtime/agent-review/reviewer-agent.test.ts test/runtime/agent-review/agent-review-service.test.ts test/runtime/config/runtime-config.test.ts
git commit -m "feat(agent-review): add cross reviewer setting (codex <-> opencode)"
```

---

### Task 2: Cross reviewer, settings UI

**Files:**
- Modify: `web-ui/src/components/runtime-settings-dialog.tsx:815` (reviewer `<NativeSelect>`)
- Test: `web-ui/src/components/runtime-settings-dialog.test.tsx`

**Interfaces:**
- Consumes: `RuntimeReviewerAgentSetting` including `"cross"` (Task 1).

- [ ] **Step 1: Write the failing tests**
  - Add `it("settings dialog saves reviewerAgent = cross")`, a copy of `"settings dialog saves reviewerAgent"` (`:265-287`) with `reviewerSelect.value = "cross"`. It expects `saveRuntimeConfigMock` to be called with `expect.objectContaining({ reviewerAgent: "cross" })`.
  - Add `it("settings dialog shows the saved cross reviewer")`: the loaded config has `reviewerAgent: "cross"`; assert the reviewer `<select>` has `value === "cross"`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm --prefix web-ui run test -- runtime-settings-dialog`
Expected: FAIL, because no `cross` option exists and the select value is not set.

- [ ] **Step 3: Implement**

Add `<option value="cross">Cross (Codex ↔ OpenCode)</option>` directly after the `Same as task` option. Nothing else changes.

- [ ] **Step 4: Run them and confirm they pass**

Run: `npm --prefix web-ui run test -- runtime-settings-dialog`
Expected: PASS.

- [ ] **Step 5: Full checks**

Run: `npm run web:typecheck && npm run web:test && npm run lint`
Expected: all exit 0.

- [ ] **Step 6: Commit (only when the user asks)**

```bash
git add web-ui/src/components/runtime-settings-dialog.tsx web-ui/src/components/runtime-settings-dialog.test.tsx
git commit -m "feat(web-ui): add cross option to reviewer agent setting"
```

---

### Task 3: Agent docs and ignore rules

**Files:**
- Create: `docs/agents/task-prompt-template.md`
- Modify: `AGENTS.md` (new section before "Misc. tribal knowledge", around `:89`)
- Modify: `CLAUDE.md` (one line in "Rules")
- Modify: `.gitignore` ("Local-only harness files" block)
- Modify: `MAP.md`

**Interfaces:**
- Produces: `docs/agents/task-prompt-template.md`, which the planner uses for every later task.
- Produces: the `.gitignore` entries `/.mcp.json` and `/opencode.json`. Task 4 relies on them, because Kanban only symlinks ignored paths into worktrees (`src/workspace/task-worktree.ts:273-277`).

- [ ] **Step 1:** Create `docs/agents/task-prompt-template.md` with the template from spec §4.4 verbatim, plus one opening sentence saying the planner fills it in for every Kanban task.
- [ ] **Step 2:** Add an `AGENTS.md` section titled `Shared memory` with the four rules from spec §4.6. Open it with this sentence: "Applies to implementing agents and to planning. Reviewers ignore this section." Keep it to 6 lines or fewer, because every agent loads this file on every call.
- [ ] **Step 3:** Add a rule to `CLAUDE.md`: `10. When creating Kanban tasks from a plan: alternate --agent-id opencode/codex, and fill docs/agents/task-prompt-template.md (copy needed context from memory into the prompt).`
- [ ] **Step 4:** Add `/.mcp.json` and `/opencode.json` under the "Local-only harness files" comment in `.gitignore`.
- [ ] **Step 5:** Add `docs/agents/task-prompt-template.md` to `MAP.md` ("Where to find things").
- [ ] **Step 6: Verify**

Run: `git check-ignore -v .mcp.json opencode.json && npm run lint`
Expected: both paths are reported as ignored by `.gitignore`; lint exits 0.

- [ ] **Step 7: Commit (only when the user asks)**

```bash
git add docs/agents/task-prompt-template.md AGENTS.md CLAUDE.md .gitignore MAP.md
git commit -m "docs: add task prompt template, shared memory rules, ignore memory client configs"
```

---

### Task 4: Basic Memory rollout (manual: user + Claude, main checkout, no tasks running)

Every step marked **(approval)** needs the user's explicit yes for that exact change.

- [ ] **Step 1: Install.**
  - Pick the latest `basic-memory` release that is at least two weeks old.
  - Run `uv tool install basic-memory==<version>`, then `basic-memory --version`.
  - Expected: it prints the version. Record it in `contexte/memory-orchestrator.md`.
- [ ] **Step 2: Copy test.**
  - Copy `contexte/` to a folder in the scratchpad.
  - Run `basic-memory project add mk-copy <copy>`, then `basic-memory sync --project mk-copy` (or the version's equivalent).
  - Run `diff -r <original contexte> <copy>`.
  - Expected: no differences, or only added frontmatter. **Any other difference → stop and ask the user.**
  - Remove the `mk-copy` project afterwards.
- [ ] **Step 3: (approval) Real project and LaunchAgent.**
  - Run `basic-memory project add my-kanban /Users/xuanchien/Project/claude-app/my-kanban/contexte`.
  - Write `~/Library/LaunchAgents/local.basic-memory.my-kanban.plist`:
    - `ProgramArguments`: `<uv tool bin>/basic-memory mcp --transport streamable-http --host 127.0.0.1 --port 8765 --project my-kanban`;
    - `RunAtLoad` and `KeepAlive` set to true;
    - stdout and stderr to `~/Library/Logs/basic-memory.log`.
  - Run `launchctl bootstrap gui/$(id -u) <plist>`.
  - Verify: `lsof -iTCP:8765 -sTCP:LISTEN` shows the process, bound to 127.0.0.1 only.
- [ ] **Step 4: Measure baseline.**
  - Start a fresh Claude Code session in a new task worktree and send one trivial prompt.
  - Record the first-call context (input + cache-create + cache-read) from its `~/.claude/projects/<dir>/*.jsonl`, using the method of spec §1.1.
- [ ] **Step 5: Client config** (repo-local, gitignored after Task 3). In the main checkout:
  - create `.mcp.json` and `opencode.json` with the contents in spec §6;
  - add `"enabledMcpjsonServers": ["basic-memory"]` to `.claude/settings.local.json`.
  - Verify: in a fresh task worktree, `ls -l .mcp.json opencode.json` shows symlinks.
- [ ] **Step 6: Smoke test.** In a fresh task worktree:
  - in Claude Code, `/mcp` lists `basic-memory` as connected, and a memory search for "parallel sessions" returns `parallel-sessions.md`;
  - in OpenCode, run the same search.
  - Expected: both return the note.
- [ ] **Step 7: Measure after.**
  - Repeat Step 4.
  - Expected: the first-call context grew by ≤ ~5 k tokens. If it grew more, report the number to the user and do not continue (spec AG5).
- [ ] **Step 8:** Update `contexte/memory-orchestrator.md` with the version, the before/after numbers and the date.

### Task 5: Switch on cross review

- [ ] After Task 2 is merged and the runtime rebuilt: Settings → Reviewer agent → **Cross (Codex ↔ OpenCode)** → Save.
- [ ] Verify: the next OpenCode task's reviewer log shows `reviewerAgentId: "codex"`.
