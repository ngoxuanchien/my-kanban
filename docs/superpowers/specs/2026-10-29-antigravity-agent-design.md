# Antigravity agent — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-agent-handoff-design.md`, `2026-10-29-quota-handoff-design.md`, `2026-10-29-sidebar-agent-review-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Intent

Add Google Antigravity (CLI binary `agy`, v1.4.10 installed at `~/.local/bin/agy`) as a third task agent that works **exactly like Codex and OpenCode** **[user]**: it implements Kanban tasks in their own worktree, is reviewed by the sidebar agent, and joins the handoff chain so a stuck task can pass through all three agents before the user is pulled in **[user]**. The point is more capacity for "I don't care which agent, it just has to get done": a third agent when Codex/OpenCode quota runs out.

## 2. Goals, non-goals, anti-goals

### Goals
- G1. `antigravity` is a launchable agent id: selectable with `task create/update --agent-id antigravity` and in the web-ui agent picker, detected when `agy` is on PATH.
- G2. A task session runs `agy` in the task worktree in autonomous mode, starts on the task prompt, and moves the card In progress → Review on turn end, like Codex/OpenCode (hook-driven, not output scraping).
- G3. The Kanban append-system-prompt (task-agent instructions) reaches Antigravity, as it does for other agents.
- G4. Handoff chain over three agents **[user]**: fixed cycle `codex → opencode → antigravity → codex` **[assistant's call]**. A task may be handed off **up to twice**, so it visits every agent once; each agent gets 3 review rounds, **9 rounds in total** **[user]**. Round 9 failing leaves the task in Review and the sidebar reports to the user.
- G5. All existing handoff triggers (review round cap, crash, quota text) work for Antigravity tasks and for handing off *to* Antigravity.
- G6. The planner rotation for new Kanban tasks becomes `opencode / codex / antigravity` (update `CLAUDE.md` rule 10, and `docs/agents/task-prompt-template.md` if it names the rotation). **[user: "like Codex, OpenCode"]**

### Non-goals
- Choosing the agent from the task's content or cost.
- Choosing the Antigravity model; `agy` uses its default model. **[assistant's call]**
- Re-enabling the `gemini` agent.
- Adding `antigravity` to `AUTO_SELECT_AGENT_PRIORITY` (`src/config/runtime-config.ts:57`). **[assistant's call]**
- Handoff to Claude or Cline.

### Anti-goals
- Writing Kanban hooks into the user's global Antigravity config (`~/.gemini/...`), or committing hook files into the task branch.
- A task bouncing back to an agent it already used.
- Breaking existing boards: a saved card with `handedOff: true` must still load and keep its 6-round cap.

## 3. How it works

### 3.1 What `agy` offers (from `agy --help` and its embedded `hooks.json` docs)
- `--dangerously-skip-permissions` — auto-approve all tools (autonomous mode).
- `-i/--prompt-interactive <prompt>` — run an initial prompt and stay interactive. `--continue` resumes the latest conversation.
- `--settings <json|path>` — per-session settings, never saved.
- Lifecycle hooks in `hooks.json` at a customization root (documented example `.agents/hooks.json`): events `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. Handlers are `{"type":"command","command":...}`, get JSON on stdin (camelCase, includes `conversationId`, `workspacePaths`), and must print JSON on stdout. `Stop` carries `terminationReason` (`NO_TOOL_CALL` = normal turn end, `ERROR`, `USER_CANCELED`, ...). `SessionStart` / `PreInvocation` can return `{"injectSteps":[{"systemMessage":{"systemMessage":"..."}}]}`.

**Not verified yet** (a local spike was blocked): whether hooks fire in interactive `-i` mode, and how to point `agy` at a hooks file without writing into the worktree. **Step 1 of the build is a spike that answers both** **[builder]**, in this order of preference:
1. `--settings` or another flag that loads hooks from a Kanban-owned path (under `getHookAgentDirectory("antigravity")`, like the Gemini adapter's `settings.json`);
2. `--add-dir <kanban-owned dir>` if a customization root there is honoured;
3. last resort: write `<worktree>/.agents/hooks.json` and add `.agents/` to the worktree's `.git/info/exclude` so it never reaches a commit.

If none of these makes `Stop` fire in an interactive session, stop and report to the user before building the rest.

### 3.2 Catalog and ids
- `src/core/api-contract.ts:74` — add `"antigravity"` to `runtimeAgentIdSchema`.
- `src/core/agent-catalog.ts` — entry `{ id: "antigravity", label: "Antigravity", binary: "agy", baseArgs: [], autonomousArgs: ["--dangerously-skip-permissions"], installUrl: "https://antigravity.google" }`, and add it to `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`.
- Every other closed list of agent ids: `normalizeAgentId` in `src/config/runtime-config.ts:118-130`, `src/prompts/append-system-prompt.ts` (agent list and the Linear MCP hint switch), `src/commands/hooks.ts` source detection, CLI help text for `--agent-id`, and the sidebar prompt's `--agent-id` list. Grep for `"kiro"` / `"opencode"` to find them all.

### 3.3 Session adapter (`src/terminal/agent-session-adapters.ts`)
New `antigravityAdapter`, modelled on the Gemini/Claude adapters:
- args: base args, `--dangerously-skip-permissions` when autonomous, the task prompt via `-i`, `--continue` on resume.
- hooks wired as found in 3.1, each calling the shared hook entry (`buildHooksCommand([...])`) with source `antigravity`: `PreInvocation`/`PreToolUse` → running/activity, `Stop` with `NO_TOOL_CALL` → turn end (to Review), `Stop` with `ERROR` → error. The hook command must always print valid JSON (`{}`) so it never blocks `agy`.
- append-system-prompt delivered through a `SessionStart` hook `systemMessage`, unless the spike finds a direct flag. **[builder]**

### 3.4 Handoff over three agents
Replace the boolean with a count, because both the next agent and the round cap depend on how many handoffs happened:
- Card field `handOffCount?: number` (0–2) in `src/core/api-contract.ts`, `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts`. Normalising a saved card: `handOffCount` if present, else `handedOff === true ? 1 : 0`. New writes drop `handedOff`. **[assistant's call]**
- `src/server/hand-off-task.ts`: `HandOffAgentId = "codex" | "opencode" | "antigravity"`; next agent = successor in the fixed cycle; refuse when `handOffCount >= 2`, review is off, or the agent is not in the cycle. With a fixed three-member cycle, two successive handoffs always visit three distinct agents. The handoff prompt keeps its wording; on the second handoff it names both previous agents.
- Cap everywhere = `3 * (handOffCount + 1)`: `src/server/sidebar-review-queue.ts:18,25`, `src/server/sidebar-review-service.ts:248`, `web-ui/src/components/board-card.tsx:58`. One shared helper used by runtime and web-ui. **[builder: exact location]**
- Reset paths that today set `handedOff: false` (`sidebar-review-service.ts:274-276`) set `handOffCount: 0`.
- `sidebar-review-service.ts:92,217`: replace the `codex || opencode` checks with "agent is in the handoff cycle", and `handedOff !== true` with `handOffCount < 2`.
- Card label (`board-card.tsx:473`): `Handed off` after one, `Handed off ×2` after two. **[assistant's call]**
- Sidebar instructions (`src/prompts/append-system-prompt.ts`, "Reviewing tasks" steps 3–4): at the cap, run `task handoff` while the task can still be handed off; on round 9/9, or when handoff is refused, leave it in Review and report. Replace the hard-coded `3/3` and `6/6` wording with "the cap".

### 3.5 Quota detection
`src/server/usage-limit-detector.ts` holds usage-limit phrases. Add Antigravity's usage-limit text only if found (in `agy` strings or a real session); otherwise leave a note in the task report. A quota error that makes `agy` exit is already caught by the crash trigger. **[builder]**

## 4. Risks
- Hooks may not fire in interactive mode → card never leaves In progress. Mitigated by the spike gate in 3.1.
- `agy` may ask for workspace trust on a new worktree path (its settings have `trustedWorkspaces`). The spike checks this; if it prompts, find a per-session way around it without editing global settings, or report. **[builder]**
- Antigravity free quota is unknown; a task may reach Antigravity and stall. The user sees it in Review after round 9 or via the quota trigger.

## 5. Tests
- Catalog/schema: `antigravity` parses, is launch-supported, `normalizeAgentId("antigravity")` returns it.
- Adapter: built args include `--dangerously-skip-permissions`, `-i <prompt>`, and the hook wiring; resume adds `--continue`.
- Hook command: `Stop` with `NO_TOOL_CALL` → review transition; with `ERROR` → error; always prints valid JSON.
- `handOffTask`: codex→opencode→antigravity, opencode→antigravity→codex, antigravity→codex→opencode; third handoff refused; count increments; worktree untouched.
- Cap helper: 3 / 6 / 9; legacy `handedOff: true` normalises to count 1 (cap 6).
- Queue wake-up text `round 7/9`; sidebar service crash trigger on an `antigravity` task hands off.
- Acceptance: `npm run typecheck`, `npm run lint`, `npm run test:fast`, and one small real task on `antigravity` end to end (In progress → Review).

## 6. Left to the builder
- Hook wiring mechanism and trust handling (3.1, 4).
- How the system prompt reaches `agy` (3.3).
- Location of the shared cap helper (3.4).
- Antigravity quota phrase (3.5).
