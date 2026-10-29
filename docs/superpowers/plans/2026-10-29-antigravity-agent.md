# Antigravity Agent Implementation Plan

> **For agentic workers:** Each task below is one Kanban task, run by Codex or OpenCode in its own worktree and reviewed by the sidebar agent. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Antigravity (`agy`) as a third task agent and extend the handoff chain to codex → opencode → antigravity with up to 9 review rounds.

**Architecture:** Task 1 adds the `antigravity` agent id, catalog entry, session adapter and hook entrypoint, gated by a spike that proves `agy` hooks fire in an interactive session. Task 2 replaces the `handedOff` boolean with `handOffCount`, adds a shared round-cap helper, and moves the handoff cycle to three agents.

**Tech Stack:** TypeScript (Node runtime in `src/`), React web-ui (`web-ui/src/`), Vitest, Zod.

**Spec:** `docs/superpowers/specs/2026-10-29-antigravity-agent-design.md`

## Global Constraints

- Agent id `antigravity`, label `Antigravity`, binary `agy`, autonomous arg `--dangerously-skip-permissions`, install URL `https://antigravity.google`.
- Never write Kanban hooks into `~/.gemini/...` or any global agent config; hook files must never reach a task commit.
- Handoff cycle is fixed: `codex → opencode → antigravity → codex`. Max 2 handoffs. Round cap = `3 * (handOffCount + 1)` (3 / 6 / 9).
- Saved cards with `handedOff: true` and no `handOffCount` load as `handOffCount: 1`.
- `antigravity` is NOT added to `AUTO_SELECT_AGENT_PRIORITY`. The `gemini` agent stays disabled.
- Acceptance for every task: `npm run typecheck`, `npm run lint`, `npm run test:fast` pass.

## Review Focus

1. `agy` asks for workspace trust on a fresh worktree path → session hangs In progress. Task 1 spike checks this on a path outside `trustedWorkspaces`.
2. The hook process writes nothing or invalid JSON → `agy` blocks or errors. Task 1 test: hook entrypoint prints `{}` even on empty/invalid stdin.
3. A board saved before this change (`handedOff: true`) → cap stays 6, the next handoff goes to the third agent, not refused. Task 2 test.
4. A task started on `antigravity` crashes → crash trigger hands it off to `codex`. Task 2 test.
5. `Stop` with `USER_CANCELED` must not move the card to Review as a finished turn. Task 1 test.

---

### Task 1: Antigravity agent id, adapter and hooks (agent: opencode)

**Files:**
- Modify: `src/core/api-contract.ts:74`, `src/core/agent-catalog.ts`, `src/config/runtime-config.ts:118-130`, `src/prompts/append-system-prompt.ts` (agent list ~31-37, Linear hint switch ~60-70, `--agent-id` lists), `src/terminal/agent-session-adapters.ts`, `src/commands/hooks.ts`, `src/commands/task.ts` (`--agent-id` help text), plus any other closed agent-id list found by `grep -rn '"kiro"' src web-ui/src`.
- Create: `contexte/antigravity-agent.md` (spike findings), and add its row to the `contexte/` table in `MAP.md`.
- Test: `test/runtime/terminal/agent-session-adapters.test.ts`, new `test/runtime/antigravity-hook-events.test.ts`, the existing config test that covers `normalizeAgentId`.

**Interfaces:**
- Produces: `"antigravity"` in `runtimeAgentIdSchema` / `RuntimeAgentId`; launch-supported catalog entry; CLI subcommand `kanban hooks antigravity-hook --event <AgyEventName>`; exported `mapAntigravityHookEvent(eventName: string, payload: Record<string, unknown> | null): RuntimeHookEvent | null` in `src/commands/hooks.ts`.

- [ ] **Step 1: Spike (gate).** In a scratch git repo outside `/Users/xuanchien` (e.g. `/tmp/agy-spike`), find how to load a `hooks.json` from a Kanban-owned directory for one session, in this order: `--settings`, an env var (search `strings ~/.local/bin/agy` for settings/hooks/customization path variables), `--add-dir`, last resort `<worktree>/.agents/hooks.json` + `.agents/` in `.git/info/exclude`. Run `agy --dangerously-skip-permissions -i "Reply OK"` with `SessionStart`, `PreInvocation`, `Stop` hooks that append stdin to a file. Record which mechanism works, whether hooks fire in `-i` mode, the exact `Stop` payload, and whether a trust prompt appears, in `contexte/antigravity-agent.md`. **If no mechanism makes `Stop` fire in `-i` mode, stop and report; do not build the rest.**
- [ ] **Step 2: Write failing tests.**
  - `normalizeAgentId("antigravity")` returns `"antigravity"`; `isRuntimeAgentLaunchSupported("antigravity")` is true.
  - Adapter `prepare` for `agentId: "antigravity"`, autonomous, prompt `"do X"` → args contain `--dangerously-skip-permissions` and `["-i", "do X"]`; with `resumeFromTrash` → args contain `--continue`; hook config written under `~/.cline/kanban/hooks/antigravity/` (same root the gemini test checks at ~line 225) and wired with the Step 1 mechanism; every hook command contains `antigravity-hook`.
  - `mapAntigravityHookEvent("Stop", { terminationReason: "NO_TOOL_CALL" })` → `"to_review"`; `("Stop", { terminationReason: "ERROR" })` → `"to_review"`; `("Stop", { terminationReason: "USER_CANCELED" })` → `null`; `("PreInvocation", {})` → `"to_in_progress"`; `("PreToolUse", {})` and `("PostToolUse", {})` → `"activity"`.
  - The hook subcommand prints `{}\n` for empty stdin and for invalid JSON.
- [ ] **Step 3: Run tests, verify they fail.** `npx vitest run test/runtime/terminal/agent-session-adapters.test.ts test/runtime/antigravity-hook-events.test.ts` → FAIL.
- [ ] **Step 4: Implement.** Add the id to the schema, catalog (+ `RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS`), `normalizeAgentId`, and the append-system-prompt lists. Add `antigravityAdapter` modelled on `geminiAdapter` (`agent-session-adapters.ts:609`): config under `getHookAgentDirectory("antigravity")`, `createHookRuntimeEnv`, one hook command per event built with `buildHooksCommand(["antigravity-hook", "--event", <EventName>])` (the `agy` payload has no event-name field). Deliver the append-system-prompt through a `SessionStart` hook reply `{"injectSteps":[{"systemMessage":{"systemMessage":"<prompt>"}}]}` unless Step 1 found a flag. Add the `antigravity-hook` subcommand next to `gemini-hook` (`hooks.ts:783`), modelled on `runGeminiHookSubcommand` (`hooks.ts:557`), with source `"antigravity"`. Register the adapter wherever `geminiAdapter` is registered. If the spike or `strings ~/.local/bin/agy` shows Antigravity's usage-limit message, add it to `USAGE_LIMIT_PHRASES` in `src/server/usage-limit-detector.ts`; otherwise note "not found" in `contexte/antigravity-agent.md`.
- [ ] **Step 5: Run tests, verify they pass**, then `npm run typecheck && npm run lint && npm run test:fast`.
- [ ] **Step 6: Manual end-to-end.** Run Kanban from the worktree (`npm run dev` or the `docs/smoke-tests/` flow) on a throwaway git repo, create a tiny task with `--agent-id antigravity`, start it, confirm the card reaches Review. Paste the evidence.

### Task 2: Handoff chain over three agents (agent: codex; linked after Task 1)

**Files:**
- Create: `src/core/hand-off-cap.ts`
- Modify: `src/core/api-contract.ts:142` (card schema), `web-ui/src/types/board.ts:48`, `web-ui/src/state/board-state.ts:162,204`, `src/server/hand-off-task.ts`, `src/server/sidebar-review-queue.ts:6,18,25`, `src/server/sidebar-review-service.ts:92,97,216-217,248,274-276`, `web-ui/src/components/board-card.tsx:58,473`, `src/prompts/append-system-prompt.ts:334-335`, `CLAUDE.md:25`, `docs/agents/task-prompt-template.md` only if it names the rotation.
- Test: `test/runtime/server/hand-off-task.test.ts`, `test/runtime/server/sidebar-review-queue.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`, new `test/runtime/core/hand-off-cap.test.ts`, `test/runtime/append-system-prompt.test.ts`.

**Interfaces:**
- Consumes: `"antigravity"` in `RuntimeAgentId` (Task 1).
- Produces in `src/core/hand-off-cap.ts` (import it from web-ui the same way web-ui already imports other `src/core` code; if it cannot, duplicate only `getReviewRoundCap` under `web-ui/src/utils/` and say so):
  - `export const HAND_OFF_CYCLE = ["codex", "opencode", "antigravity"] as const;`
  - `export type HandOffAgentId = (typeof HAND_OFF_CYCLE)[number];`
  - `export const MAX_HAND_OFFS = 2;`
  - `export function isHandOffAgentId(id: RuntimeAgentId | undefined): id is HandOffAgentId`
  - `export function nextHandOffAgent(id: HandOffAgentId): HandOffAgentId`
  - `export function getHandOffCount(card: { handOffCount?: number; handedOff?: boolean }): number`
  - `export function getReviewRoundCap(card: { handOffCount?: number; handedOff?: boolean }): number`
- Card field `handOffCount?: number` (int 0–2). `handedOff` stays optional in the schema for legacy data and is never written.

- [ ] **Step 1: Write failing tests.**
  - `hand-off-cap.test.ts`: `nextHandOffAgent("codex") === "opencode"`, `("opencode") === "antigravity"`, `("antigravity") === "codex"`; `getReviewRoundCap({}) === 3`, `({ handOffCount: 1 }) === 6`, `({ handOffCount: 2 }) === 9`, `({ handedOff: true }) === 6`; `getHandOffCount({ handedOff: true }) === 1`; `isHandOffAgentId("claude") === false`.
  - `hand-off-task.test.ts`: starting on codex → two handoffs give opencode then antigravity, `handOffCount` 1 then 2; starting on antigravity → codex then opencode; third handoff refused with error `"Task has already been handed off twice"`; legacy card `{ agentId: "opencode", handedOff: true }` hands off to `antigravity` with `handOffCount: 2`; the second-handoff prompt names both previous agents; worktree create/reset not called.
  - `sidebar-review-queue.test.ts`: card with `handOffCount: 2`, `reviewRound: 7` → wake-up text contains `round 7/9`.
  - `sidebar-review-service.test.ts`: crash summary on a review-enabled `antigravity` card with `handOffCount: 0` → `handOffTask` called; with `handOffCount: 2` → not called; reset path sets `handOffCount: 0`.
  - `append-system-prompt.test.ts`: review instructions contain `9/9` and no longer contain `6/6`.
- [ ] **Step 2: Run tests, verify they fail.** `npx vitest run test/runtime/core/hand-off-cap.test.ts test/runtime/server test/runtime/append-system-prompt.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Add `hand-off-cap.ts`. In `hand-off-task.ts`, remove the local `HandOffAgentId` / `isHandOffAgentId`, use the helpers, refuse when `getHandOffCount(card) >= MAX_HAND_OFFS`, write `handOffCount: count + 1` and drop `handedOff` from the written card. `buildHandOffPrompt` takes `previousAgentIds: HandOffAgentId[]` instead of `fromAgentId` and lists them. Replace every `handedOff === true ? 6 : 3` and `codex || opencode` check listed in Files with the helpers. Card label: `handOffCount === 1` → `Handed off`, `=== 2` → `Handed off ×2`; review label uses `getReviewRoundCap`. Sidebar "Reviewing tasks" step 4 becomes: "If it fails at its cap and the cap is below 9, run `task handoff --task-id <task_id> --message "<the same concrete fix list>"` and report it in one chat line. If handoff returns an error, or it fails on round 9/9, do not send another fix request: leave it in Review and report the reasons to the user in the chat." `CLAUDE.md:25` rule 10 becomes: `alternate --agent-id opencode/codex/antigravity`.
- [ ] **Step 4: Run tests, verify they pass**, then `npm run typecheck && npm run lint && npm run test:fast` (and the web-ui typecheck if it is separate).
