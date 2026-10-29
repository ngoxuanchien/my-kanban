# Quota Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hand a review-enabled codex/opencode task to the other agent as soon as its terminal shows a usage-limit message.

**Architecture:** A pure detector (`src/server/usage-limit-detector.ts`) scans the last 40 lines of the ANSI-stripped terminal snapshot. The sidebar review service runs it on a reviewable turn end, before the empty-task check, and calls the existing `deps.handOffTask`.

**Tech Stack:** TypeScript (Node ≥ 22, ESM), vitest.

**Spec:** `docs/superpowers/specs/2026-10-29-quota-handoff-design.md`

## Global Constraints

- Phrases: `Free usage limit reached` (OpenCode), `hit your usage limit` (Codex, confirm against the installed CLI). Case-insensitive substrings, last 40 lines only.
- Reason (exact): `The previous agent hit its usage limit ("<matched phrase>").`
- Both-agents warn (exact): `[sidebar-review] Task <id>: both agents hit their usage limit; leaving it in Review`
- No new dependency. No `any`, no inline imports. `npm run lint` includes formatting.

## Review Focus

1. A long agent reply that quotes a phrase far above the bottom of the screen → no handoff (detector test: phrase only above the last 40 lines).
2. Quota on the second agent → no nudge, no wake-up, task stays in Review (service test 2).
3. Snapshot unavailable (Cline session, `null`, or throws) → today's behaviour (service tests 4–5).
4. `handOffTask` refused → falls back to today's behaviour, not silently stuck (service test 3).
5. A crash after a quota handoff → no second handoff (already covered by the crash-trigger tests; keep them passing).

---

### Task 1: Usage-limit detector and quota trigger (codex)

**Files:**
- Create: `src/server/usage-limit-detector.ts`
- Modify: `src/server/sidebar-review-service.ts` (`handleSummary`, reviewable branch, before the empty-task check)
- Test: `test/runtime/server/usage-limit-detector.test.ts`, `test/runtime/server/sidebar-review-service.test.ts`

**Interfaces:**
- Consumes: `deps.terminalManager.getRestoreSnapshot(taskId): Promise<{ snapshot: string; cols: number; rows: number } | null>`; `deps.handOffTask(taskId, reason)`.
- Produces: `export const USAGE_LIMIT_PHRASES: readonly string[]`; `export function detectUsageLimit(screenText: string): string | null`.

- [x] **Step 1: Failing tests** — the 4 detector tests and 5 service tests listed in spec section 5.
- [x] **Step 2:** `npx vitest run test/runtime/server` → new tests FAIL.
- [x] **Step 3: Implement** per spec sections 3–4.
- [x] **Step 4:** `npm run typecheck && npm run test:fast && npm run lint` → PASS.
