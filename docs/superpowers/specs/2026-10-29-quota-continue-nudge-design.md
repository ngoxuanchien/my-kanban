# Quota continue nudge — design

Date: 2026-10-29
Status: approved in chat by the user on 2026-10-29
Builds on: `2026-10-29-quota-handoff-design.md`, `2026-10-29-quota-retry-and-review-notes-design.md`

Labels: **[user]** decided by the user; **[assistant's call]** decided while writing, the user may revise.

## 1. Why

Some agents hit a short-lived usage or rate limit and stay stuck in "processing". Kanban never notices this: the usage-limit check in `src/server/sidebar-review-service.ts` (`processReviewableSummary`, ~:186) only runs after the session stops (`awaiting_review`). When it does run, it hands off or marks the card "Out of quota" at once, even though sending `continue` often gets the agent going again. **[user]**

## 2. Goals, non-goals

### Goals
- G1. Before Kanban hands off or marks a task "Out of quota", it sends `continue` **once** to the task's agent session. Then it waits **5 minutes** and checks again. **[user]**
- G2. A running task (`state === "running"`) is treated as stuck when either:
  - its terminal shows a usage-limit phrase (`detectUsageLimit`), or
  - it has produced no terminal output for **5 minutes** (`lastOutputAt`).

  Kanban sends it `continue` once. **[user]**
- G3. If the agent produces new output or finishes the turn after the nudge, nothing else happens. If after 5 minutes it is still stuck, or the usage-limit phrase shows up again, today's behaviour runs: hand off, or set `quotaBlockedAt` when no handoff is left. **[user]**
- G4. At most one `continue` per task per agent turn. The nudge is reset when the task starts a new turn or is handed off. **[assistant's call]**
- G5. A nudge never changes scores, and it records a `retry` history event with detail `continue sent (usage limit or no output for 5 min)`. **[assistant's call]**

### Non-goals
- Changing the hourly retry of quota-blocked cards, or the handoff chain.
- Nudging tasks without a session, Cline-native tasks, and home/sidebar sessions.

## 3. Behaviour

- Send with `sendPromptToSession` (`src/terminal/send-prompt-to-session.ts`), using the prompt text `continue`.
- **Antigravity** loses messages sent while it is mid-turn (`contexte/antigravity-agent.md`). For a running agy session, send a bare Enter keystroke instead of text. For agy in `awaiting_review`, send `continue`. **[assistant's call]**
- **Running-stuck check:** run it on the existing 5-minute interval in the review service (the one that runs `retryQuotaBlockedTasks`), or a 1-minute interval if that keeps timing within ±1 minute. Only look at cards in `in_progress` or `review` whose session is `running`. **[assistant's call]**
- **Review-time check:** when `processReviewableSummary` detects a usage-limit phrase and no nudge has been sent this turn, it sends `continue`, records the time, and returns without handing off. On the next check, at least 5 minutes later, if the phrase is still the latest screen state and no new turn has started, it falls through to the existing handoff or quota-blocked code.
- **Nudge state:** keep it in memory in the service (`Map<taskId, { sentAt, turn }>`, keyed by `latestTurnCheckpoint.turn` or `startedAt`). A runtime restart may send one extra `continue`, which is acceptable. **[assistant's call]**

## 4. Tests

- Review-time:
  - The first usage-limit detection sends `continue` and does not hand off.
  - The same phrase 5 minutes later, in the same turn, hands off; with `MAX_HAND_OFFS` reached, it sets `quotaBlockedAt` instead.
  - New output or a new turn after the nudge means no handoff.
- Running:
  - No output for 5 minutes sends `continue` once.
  - A second check in the same turn sends nothing.
  - Output within 5 minutes sends nothing.
  - A usage-limit phrase while running sends `continue`.
- Antigravity running → Enter keystroke, not text.
- No score events. A `retry` history event with the detail text is recorded.

Acceptance: `npm run typecheck`, `npm run lint`, `npm run test:fast`.
