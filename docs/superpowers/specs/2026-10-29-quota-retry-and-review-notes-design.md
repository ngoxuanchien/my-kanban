# Quota retry and review notes — design

Date: 2026-10-29
Status: draft for the user to approve
Builds on: `2026-10-29-quota-handoff-design.md`, `2026-10-29-agent-handoff-design.md`, `2026-10-29-antigravity-agent-design.md`, `2026-10-29-card-review-label-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise; **[builder]** left to the builder.

## 1. Why

The project goal is that tasks get done by whichever agent (codex, opencode, antigravity) still has quota, and that what one agent learns is not lost for the next one. Three gaps remain:

1. Antigravity's usage-limit text is not in the detector, so an agy task that runs out of quota burns review rounds instead of being handed off at once.
2. When every agent in the handoff chain is out of quota, the runtime leaves the task in Review and only writes a `warn` line to the server log (`src/server/sidebar-review-service.ts:98-105`). On the board the card looks like any task waiting for review, and nothing ever picks it up again.
3. When the sidebar agent passes a task that needed fix rounds, the lesson behind those rounds is not written down anywhere the next agent or planner will see it.

## 2. Findings that shaped this (2026-10-29)

- Codex is already covered. Every usage-limit message in the installed Codex binary (`~/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`) starts with `You’ve hit your usage limit` (curly apostrophe), for example `… Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus)` and `… Visit https://chatgpt.com/settings/usage to purchase more credits`. The existing phrase `hit your usage limit` (`src/server/usage-limit-detector.ts:1`) matches all of them. No real Codex quota event exists yet in `~/.codex/sessions`.
- The Antigravity binary (`agy` 1.4.10, `~/.local/bin/agy`) contains `You have exhausted your quota on this model.` and `model %s is out of quota until %s`. Neither has been seen in a real terminal yet; `~/.gemini/antigravity-cli/cli.log` has no quota event.
- "All agents out of quota" is already detected: the quota branch returns early when `getHandOffCount(card) >= MAX_HAND_OFFS`, so no review round is spent. Only visibility and retry are missing.

## 3. Goals, non-goals, anti-goals

### Goals
- G1. Detect Antigravity's usage-limit text, so agy tasks hand off at once like opencode and codex.
- G2. A task stuck because every agent is out of quota shows **"Out of quota"** on its card. **[user]**
- G3. Kanban retries such a task by itself every hour, in the same worktree, with the next agent in the cycle, until one agent gets through. **[user]**
- G4. After a pass that was not first-try, the sidebar agent writes the lesson into `contexte/`. **[user approved the proposal]**

### Non-goals
- Asking a provider whether quota is back before retrying. There is no API for it; agy's "until" time is not parsed. **[assistant's call]**
- Countdown to the next retry on the card, notifications, or a retry cap. **[user]**
- Task agents (codex/opencode/antigravity) writing to memory themselves. Codex has no memory, and weak agents are not trusted with it (`contexte/memory-orchestrator.md`).
- Any change for Codex detection.

### Anti-goals (failure even if it "works")
- A retry that spends a review round or wakes the sidebar for a review that cannot pass.
- Notes in `contexte/` that restate the task, the diff, or a work log; or any secret in a note.
- A retry loop that keeps running after the user moves the task to Done/Trash or turns review off.

## 4. Part 1 — Antigravity usage-limit phrases

Add to `USAGE_LIMIT_PHRASES` in `src/server/usage-limit-detector.ts`:
- `exhausted your quota` (from `You have exhausted your quota on this model.`)
- `out of quota until` (from `model %s is out of quota until %s`) **[assistant's call]**

Matching stays as today: ANSI stripped, last 40 lines, case-insensitive substring. `isHandOffAgentId` already includes `antigravity`, so the existing quota branch applies unchanged.

**[builder]** If you can make agy show a real quota message, check the text against these phrases and record the real text in `contexte/antigravity-agent.md`. Do not burn the user's quota on purpose.

## 5. Part 2 — "Out of quota" state on the card

### Data
Add an optional field to `runtimeBoardCardSchema` (`src/core/api-contract.ts:140`):
- `quotaBlockedAt: z.number().optional()` — epoch ms when the task was found stuck because every agent is out of quota. Absent = not blocked. **[assistant's call]** Stored on the card so the label and the retry survive an app restart.

### When it is set
In `processReviewableSummary` (`src/server/sidebar-review-service.ts:98`), in the branch where a usage-limit phrase matched and `getHandOffCount(card) >= MAX_HAND_OFFS`: set `quotaBlockedAt = now` on the card through `mutateWorkspaceState`, broadcast the state, and return (no nudge, no round, no wake-up — as today). Keep the one-time `warn`.

### When it is cleared
- When a retry starts (Part 3), in the same state mutation that switches the agent.
- In `notifyBoardChanged` (`sidebar-review-service.ts:263-276`), wherever `reviewRound`/`handOffCount` are reset today (card in trash, or review turned off).
- In `notifyBoardChanged`, for any card that has `quotaBlockedAt` but is no longer in the `review` column (the user moved it to In Progress, Done, or elsewhere). Otherwise a stale timestamp, always older than an hour, would fire a retry the moment the card comes back to Review, possibly in the middle of a normal review. **[assistant's call]**
- On any reviewable turn end where no usage-limit phrase matched (the agent did work, so quota is back). **[assistant's call]**

### Restart
`start()` re-queues Review cards with `reviewRound >= 1` for a sidebar review (`sidebar-review-service.ts:240-248`). Skip cards with `quotaBlockedAt` there: they cannot pass a review, and the retry check owns them. **[assistant's call]**

### Card label
`web-ui/src/components/board-card.tsx:473-488` builds the agent line from `agentOverrideLabel · modelOverrideLabel · handoffLabel · reviewLabel`. Add `Out of quota` after the review label when `card.quotaBlockedAt` is set and the card is in Review, and add `card.quotaBlockedAt` to the `useMemo` dependencies. **[assistant's call]** Show it in `text-status-red`; if the line stays a single joined string, the builder may render it as a separate span to colour it, or keep it plain. **[builder]**

## 6. Part 3 — Hourly retry

### Timing
- Retry delay: **1 hour** after `quotaBlockedAt`. **[user]**
- The sidebar review service checks every **5 minutes** with `setInterval`, cleared in `dispose()`. **[assistant's call]** A card is due when it is in the `review` column, `agentReviewEnabled === true`, `quotaBlockedAt` is set, and `now - quotaBlockedAt >= 1 hour`. Inject `now()` and the interval through the service dependencies so tests do not wait.
- On `start()` the same check runs once, so a task blocked before an app restart is retried when due.

### What a retry does
Hand the task to the **next agent in `HAND_OFF_CYCLE`** (codex → opencode → antigravity → codex), continuing in the same worktree, exactly like a handoff: stop the session, switch `agentId`, move to `in_progress`, start with the handoff prompt. **[user]**

`handOffTask` (`src/server/hand-off-task.ts`) refuses when `getHandOffCount(card) >= MAX_HAND_OFFS`. Add an input flag (for example `quotaRetry: true`) that skips only that one refusal; every other refusal stays. In the same mutation, clear `quotaBlockedAt`. **[assistant's call]** The flag is internal to the runtime: do not add it to `runtimeTaskHandOffRequestSchema` (`src/core/api-contract.ts:1059`), so neither the CLI nor tRPC can bypass the handoff cap. **[assistant's call]**

Reason text for the prompt (exact): `Every agent hit its usage limit. Kanban waited 1 hour and is retrying with you.`

### Counters
- A retry increments `handOffCount` like any handoff, so the card shows `Handed off ×N` and the handoff prompt lists the earlier agents. **[assistant's call]**
- A retry does **not** change `reviewRound` and does not wake the sidebar. **[user]** Since `getReviewRoundCap` is `3 × (handOffCount + 1)`, each retry also raises the round cap by 3, so the retried agent gets at least 3 more review rounds (more if the card was blocked early). That is acceptable. **[assistant's call]**

### Sidebar review rule after retries
Step 4 of the sidebar review prompt (`src/prompts/append-system-prompt.ts:336`) hard-codes `3/3`, `6/6`, `9/9`, which no longer holds once the cap can be 12, 15, …. Rewrite steps 3–4 generically **[assistant's call]**:
- Fails and the round is below the cap and not a multiple of 3 → `task send` (as today).
- Fails on a round that is a multiple of 3 and below the cap → `task handoff`; if it returns an error (for example the handoff cap), leave the task in Review and report (as today).
- Fails on the last round (round == cap) → do not send or hand off; leave it in Review and report.
- No retry cap. The loop stops only when the user moves the card out of Review, sends it to trash, or turns review off. **[user]**

### If the retried agent is also out of quota
Its turn ends, the existing quota branch matches, `handOffCount >= MAX_HAND_OFFS`, so `quotaBlockedAt` is set again and the next retry comes an hour later with the next agent. No extra code path. If the retried session crashes instead, the existing crash path applies (it does not hand off past the cap), and the task stays in Review without `quotaBlockedAt`. **[assistant's call]**

### Failure
If the retry's `handOffTask` returns `{ ok: false }`, `warn` and reset `quotaBlockedAt = now`, so the next attempt comes an hour later instead of every 5 minutes. **[assistant's call]**

## 7. Part 4 — Review notes in `contexte/`

A prompt change in the sidebar agent's review steps (`src/prompts/append-system-prompt.ts:329-337`) plus one small code change: `task list` must expose the handoff count. Today `formatTaskRecord` (`src/commands/task.ts:345-375`) outputs `reviewRound` and `agentId` but not `handOffCount`. Add `handOffCount` (via `getHandOffCount(card)`) to that record. **[assistant's call]** A quota retry increments `handOffCount`, so it is covered too, even when it happened before any review round.

Add a step after a pass (after `task done`):

- **When:** only if the task did not pass first time: the review round was above 1, or `handOffCount` from `task list` is above 0 (handed off or retried after quota). A first-try pass writes nothing.
- **What:** at most 1–3 lines a later agent needs to avoid the same trip: the cause of a failed round and the correct fix, or surprising behaviour of the code or a tool. Never a task summary, diff, or work log; never secrets.
- **Where:** update the existing topic file in `contexte/` (Basic Memory `my-kanban` project, or the file directly if the memory server is down). Create a new file only when no topic fits, and then add it to `MAP.md`. Each entry carries the date and the task title and id.
- These files are local-only; do not commit them.

The sidebar reads the round from the `[Kanban review] … round n/cap` message and `handOffCount` from `task list`. **[assistant's call]**

## 8. Tests

- `test/runtime/server/usage-limit-detector.test.ts`: both agy phrases match (ANSI-coloured, mixed case); the Codex curly-apostrophe text `You’ve hit your usage limit. Upgrade to Plus…` matches.
- `test/runtime/server/sidebar-review-service.test.ts`:
  1. quota phrase on a card at the handoff cap → `quotaBlockedAt` set to injected `now`, no `handOffTask`, no nudge, no wake-up, state broadcast;
  2. interval tick with a Review card blocked < 1 h → nothing; ≥ 1 h → `handOffTask` called with `quotaRetry: true` and the exact reason;
  3. blocked card not in Review, or review off → no retry;
  4. `start()` with a due blocked card → retry once;
  5. retry `handOffTask` fails → warn, `quotaBlockedAt` reset to `now`;
  6. `notifyBoardChanged` with review turned off, or with the card moved out of Review → `quotaBlockedAt` cleared;
  7. reviewable turn end without a quota phrase on a blocked card → `quotaBlockedAt` cleared, normal review path;
  8. `start()` with a quota-blocked Review card at `reviewRound >= 1` → not re-queued for review;
  9. `dispose()` stops the interval.
- `task list` test: the record includes `handOffCount`.
- `hand-off-task` tests: `quotaRetry: true` passes the cap, increments `handOffCount`, clears `quotaBlockedAt`; without it the cap refusal is unchanged.
- `web-ui/src/components/board-card.test.tsx`: `Out of quota` shown when `quotaBlockedAt` is set on a Review card, absent otherwise.
- Prompt test (if one exists for `append-system-prompt.ts`): the generic round rule and the notes step are present; no hard-coded `9/9`.

Acceptance: `npm run typecheck`, `npm run lint`, `npm run test:fast`, and the web-ui tests for `board-card`.

## 9. Left to the builder
- Exact placement of the interval inside `createSidebarReviewService`, and how `now`/interval are injected. **[builder]**
- Whether the retry reuses the existing handoff dependency with an extended signature or a new dependency. **[builder]**
- Label styling detail (Part 2). **[builder]**
- After shipping: record the decisions in `contexte/memory-orchestrator.md` and note that the app needs a rebuild.
