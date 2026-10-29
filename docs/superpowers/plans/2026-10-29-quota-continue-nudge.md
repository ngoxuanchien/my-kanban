# Quota continue nudge implementation plan

Spec: `docs/superpowers/specs/2026-10-29-quota-continue-nudge-design.md`
One Kanban task (codex).

## Task 1: Send `continue` once before quota handoff / Out of quota

**Files:**
- Modify: `src/server/sidebar-review-service.ts` (review-time check in `processReviewableSummary` ~:186-245; new running-stuck check on the service interval)
- Modify, only if a keystroke helper is missing: `src/terminal/send-prompt-to-session.ts`
- Test: `test/runtime/server/sidebar-review-service.test.ts`

**Rules:** see spec §2–3. The 5-minute window is a single constant, `QUOTA_NUDGE_WAIT_MS = 300000`. Inject `now()` and the interval through the existing `deps.now` and `deps.setInterval` so tests use fake time.

- [ ] Step 1: Write the failing tests from spec §4.
- [ ] Step 2: Run them and confirm they FAIL.
- [ ] Step 3: Implement.
- [ ] Step 4: Run them and confirm they PASS, then run `npm run typecheck`, `npm run lint` and `npm run test:fast`.
- [ ] Step 5: Commit `feat(runtime): nudge a stuck agent with continue before quota handoff`.
