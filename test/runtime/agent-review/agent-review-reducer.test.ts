import { describe, expect, it } from "vitest";

import {
	type AgentReviewEffect,
	type AgentReviewEvent,
	type ReviewerOutcome,
	reduceAgentReview,
} from "../../../src/agent-review/agent-review-reducer";
import type {
	RuntimeAgentReviewResult,
	RuntimeAgentReviewState,
	RuntimeAgentReviewSummary,
	RuntimeBoardColumnId,
} from "../../../src/core/api-contract";

const NOW = 1_000;

const SUMMARY: RuntimeAgentReviewSummary = {
	whatWasDone: "Added a button.",
	whatItAffects: "Toolbar.",
	againstRequest: "Nothing",
	howVerified: "npm test: 10 passed",
	risks: "None",
};

function makeState(overrides: Partial<RuntimeAgentReviewState> = {}): RuntimeAgentReviewState {
	return {
		status: "queued",
		round: 0,
		reason: null,
		reasonDetail: null,
		fingerprint: null,
		lastResult: null,
		fixPrompts: [],
		summary: null,
		meta: null,
		updatedAt: 0,
		...overrides,
	};
}

function makeResult(overrides: Partial<RuntimeAgentReviewResult> = {}): RuntimeAgentReviewResult {
	return {
		verdict: "pass",
		appVerified: true,
		appCheck: "npm run dev: started",
		tests: [{ command: "npm test", result: "10 passed" }],
		summary: SUMMARY,
		fixPrompt: null,
		notes: null,
		...overrides,
	};
}

function reduce(
	state: RuntimeAgentReviewState | null,
	event: AgentReviewEvent,
	options: { columnId?: RuntimeBoardColumnId; autoReviewEnabled?: boolean; autoReviewMode?: "commit" | "pr" } = {},
) {
	return reduceAgentReview({
		state,
		columnId: options.columnId ?? "review",
		autoReviewEnabled: options.autoReviewEnabled ?? true,
		autoReviewMode: options.autoReviewMode ?? "commit",
		now: NOW,
		event,
	});
}

function finished(outcome: ReviewerOutcome, fingerprint = "fp-1"): AgentReviewEvent {
	return { type: "reviewer_finished", outcome, fingerprint, reviewerAgentId: "claude", now: NOW };
}

function fail(fixPrompt: string): ReviewerOutcome {
	return { kind: "result", result: makeResult({ verdict: "fail", summary: null, fixPrompt }) };
}

describe("reduceAgentReview", () => {
	describe("turn_ended", () => {
		it("with no changes flags no_changes and moves to review without enqueueing", () => {
			const { state, effects } = reduce(
				makeState({ status: "fixing", round: 2 }),
				{ type: "turn_ended", hasChanges: false, fingerprint: "fp-empty" },
				{ columnId: "in_progress" },
			);
			expect(state).toMatchObject({ status: "no_changes", fingerprint: "fp-empty", round: 2 });
			expect(effects).toEqual([{ type: "move_card", to: "review" }]);
		});

		it("with changes in in_progress moves to review and enqueues", () => {
			const { state, effects } = reduce(
				null,
				{ type: "turn_ended", hasChanges: true, fingerprint: "fp-1" },
				{ columnId: "in_progress" },
			);
			expect(state).toMatchObject({ status: "queued", round: 0, fixPrompts: [], updatedAt: NOW });
			expect(effects).toEqual([{ type: "move_card", to: "review" }, { type: "enqueue_review" }]);
		});

		it.each(["passed", "no_changes"] as const)("with the same fingerprint as %s changes nothing", (status) => {
			const before = makeState({ status, fingerprint: "fp-1" });
			const { state, effects } = reduce(before, { type: "turn_ended", hasChanges: true, fingerprint: "fp-1" });
			expect(state).toBe(before);
			expect(effects).toEqual([]);
		});

		it("with a new fingerprint after passed reviews again", () => {
			const { state, effects } = reduce(makeState({ status: "passed", fingerprint: "fp-1" }), {
				type: "turn_ended",
				hasChanges: true,
				fingerprint: "fp-2",
			});
			expect(state?.status).toBe("queued");
			expect(effects).toEqual([{ type: "enqueue_review" }]);
		});

		it("while committing does not enqueue a review", () => {
			const before = makeState({ status: "committing" });
			const { state, effects } = reduce(before, { type: "turn_ended", hasChanges: true, fingerprint: "fp-2" });
			expect(state).toBe(before);
			expect(effects).toEqual([]);
		});

		it("in user_review is ignored", () => {
			const before = makeState({ status: "needs_user", reason: "round_limit" });
			const { state, effects } = reduce(
				before,
				{ type: "turn_ended", hasChanges: true, fingerprint: "fp-2" },
				{ columnId: "user_review" },
			);
			expect(state).toBe(before);
			expect(effects).toEqual([]);
		});
	});

	describe("reviewer_finished", () => {
		it("fail at round 0 sends fix round 1", () => {
			const { state, effects } = reduce(makeState({ status: "reviewing" }), finished(fail("1. Fix the test")));
			expect(state).toMatchObject({
				status: "fixing",
				round: 1,
				fixPrompts: ["1. Fix the test"],
				fingerprint: "fp-1",
			});
			expect(effects).toEqual([{ type: "send_fix", fixPrompt: "1. Fix the test", round: 1 }]);
		});

		it("the 4th failed review goes to user_review with round_limit after exactly 3 fixes", () => {
			let state: RuntimeAgentReviewState | null = null;
			const allEffects: AgentReviewEffect[] = [];
			let last: AgentReviewEffect[] = [];
			for (let i = 1; i <= 4; i++) {
				const queued = reduce(
					state,
					{ type: "turn_ended", hasChanges: true, fingerprint: `fp-${i}` },
					{ columnId: "in_progress" },
				);
				const reviewed = reduce(queued.state, finished(fail(`fix ${i}`), `fp-${i}`));
				state = reviewed.state;
				last = reviewed.effects;
				allEffects.push(...queued.effects, ...reviewed.effects);
			}
			expect(state).toMatchObject({ status: "needs_user", reason: "round_limit", round: 3 });
			expect(state?.fixPrompts).toEqual(["fix 1", "fix 2", "fix 3"]);
			expect(last).toEqual([{ type: "move_card", to: "user_review" }]);
			expect(allEffects.filter((effect) => effect.type === "send_fix")).toHaveLength(3);
		});

		it("cannot_verify goes to user_review without a fix", () => {
			const { state, effects } = reduce(
				makeState({ status: "reviewing" }),
				finished({ kind: "result", result: makeResult({ verdict: "cannot_verify", appVerified: false }) }),
			);
			expect(state).toMatchObject({ status: "needs_user", reason: "cannot_verify", round: 0 });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});

		it("pass without appVerified is treated as cannot_verify", () => {
			const { state, effects } = reduce(
				makeState({ status: "reviewing" }),
				finished({ kind: "result", result: makeResult({ appVerified: false }) }),
			);
			expect(state).toMatchObject({ status: "needs_user", reason: "cannot_verify" });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});

		it.each<[ReviewerOutcome, string, string | null]>([
			[{ kind: "timeout" }, "reviewer_timeout", null],
			[{ kind: "crashed", error: "exit 1" }, "reviewer_crashed", "exit 1"],
			[{ kind: "bad_output", error: "no block" }, "reviewer_bad_output", "no block"],
			[{ kind: "unavailable", reason: "codex not installed" }, "reviewer_agent_unavailable", "codex not installed"],
			[{ kind: "modified_worktree", paths: ["a.ts", "b.ts"] }, "reviewer_modified_worktree", "a.ts\nb.ts"],
		])("%o goes to user_review as %s", (outcome, reason, reasonDetail) => {
			const { state, effects } = reduce(makeState({ status: "reviewing" }), finished(outcome));
			expect(state).toMatchObject({ status: "needs_user", reason, reasonDetail });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});

		it("pass with autoReview on saves the summary and commits with the card's mode", () => {
			const { state, effects } = reduce(
				makeState({ status: "reviewing", round: 2 }),
				finished({ kind: "result", result: makeResult() }),
				{ autoReviewMode: "pr" },
			);
			expect(state).toMatchObject({
				status: "committing",
				summary: SUMMARY,
				fingerprint: "fp-1",
				meta: { commitHash: null, prUrl: null, rounds: 2, reviewerAgentId: "claude", reviewedAt: NOW },
			});
			expect(effects).toEqual([{ type: "send_commit", action: "pr" }]);
		});

		// Q1 answered by the user: option (a), always commit after a pass (Q1-B).
		it("pass with autoReview off still commits in commit mode", () => {
			const { state, effects } = reduce(
				makeState({ status: "reviewing" }),
				finished({ kind: "result", result: makeResult() }),
				{ autoReviewEnabled: false, autoReviewMode: "pr" },
			);
			expect(state).toMatchObject({ status: "committing", summary: SUMMARY });
			expect(effects).toEqual([{ type: "send_commit", action: "commit" }]);
		});

		it("is dropped when no review is active", () => {
			const before = makeState({ status: "fixing" });
			const { state, effects } = reduce(before, finished(fail("x")));
			expect(state).toBe(before);
			expect(effects).toEqual([]);
		});
	});

	describe("commit_finished", () => {
		const committing = makeState({
			status: "committing",
			round: 1,
			summary: SUMMARY,
			meta: { commitHash: null, prUrl: null, rounds: 1, reviewerAgentId: "claude", reviewedAt: 500 },
		});

		it("ok records the commit and completes Done", () => {
			const { state, effects } = reduce(committing, {
				type: "commit_finished",
				ok: true,
				commitHash: "abc123",
				prUrl: null,
			});
			expect(state?.meta).toMatchObject({ commitHash: "abc123", prUrl: null, rounds: 1 });
			expect(effects).toEqual([{ type: "complete_done" }]);
		});

		it("not ok goes to user_review with commit_failed and keeps the summary", () => {
			const { state, effects } = reduce(committing, { type: "commit_finished", ok: false });
			expect(state).toMatchObject({ status: "needs_user", reason: "commit_failed", summary: SUMMARY });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});
	});

	it("fix_send_failed goes to user_review with task_agent_not_running", () => {
		const { state, effects } = reduce(makeState({ status: "fixing", round: 1 }), { type: "fix_send_failed" });
		expect(state).toMatchObject({ status: "needs_user", reason: "task_agent_not_running" });
		expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
	});

	describe("user_input", () => {
		it("resets the round counter", () => {
			const { state, effects } = reduce(makeState({ status: "fixing", round: 2, fixPrompts: ["a", "b"] }), {
				type: "user_input",
			});
			expect(state).toMatchObject({ round: 0, fixPrompts: [] });
			expect(effects).toEqual([]);
		});

		it.each(["queued", "reviewing"] as const)("cancels a %s review and queues a fresh one", (status) => {
			const { state, effects } = reduce(makeState({ status, round: 1, fixPrompts: ["a"] }), { type: "user_input" });
			expect(state).toMatchObject({ status: "queued", round: 0, fixPrompts: [] });
			expect(effects).toEqual([{ type: "cancel_review" }, { type: "enqueue_review" }]);
		});
	});

	describe("review_failed", () => {
		it.each(["queued", "reviewing"] as const)("sends a %s review to user_review as reviewer_crashed", (status) => {
			const { state, effects } = reduce(makeState({ status }), { type: "review_failed", error: "boom" });
			expect(state).toMatchObject({ status: "needs_user", reason: "reviewer_crashed", reasonDetail: "boom" });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});

		it("ignores a card that is not being reviewed", () => {
			const before = makeState({ status: "fixing" });
			expect(reduce(before, { type: "review_failed", error: "boom" })).toEqual({ state: before, effects: [] });
		});
	});

	describe("moved_by_user", () => {
		const needsUser = makeState({
			status: "needs_user",
			reason: "round_limit",
			round: 3,
			fixPrompts: ["a", "b", "c"],
		});

		it("from user_review to review resets and enqueues a fresh review", () => {
			const { state, effects } = reduce(
				needsUser,
				{ type: "moved_by_user", to: "review" },
				{ columnId: "user_review" },
			);
			expect(state).toMatchObject({ status: "queued", round: 0, fixPrompts: [], reason: null });
			expect(effects).toEqual([{ type: "enqueue_review" }]);
		});

		it("from user_review to in_progress resets without effects", () => {
			const { state, effects } = reduce(
				needsUser,
				{ type: "moved_by_user", to: "in_progress" },
				{ columnId: "user_review" },
			);
			expect(state).toMatchObject({ round: 0, fixPrompts: [] });
			expect(effects).toEqual([]);
		});

		it("out of review mid-run cancels the review", () => {
			const { effects } = reduce(makeState({ status: "reviewing" }), { type: "moved_by_user", to: "trash" });
			expect(effects).toEqual([{ type: "cancel_review" }]);
		});
	});

	describe("toggled_off", () => {
		it("clears state and cancels a running review", () => {
			expect(reduce(makeState({ status: "reviewing" }), { type: "toggled_off" })).toEqual({
				state: null,
				effects: [{ type: "cancel_review" }],
			});
		});

		it("clears state without effects when nothing runs", () => {
			expect(reduce(makeState({ status: "passed" }), { type: "toggled_off" })).toEqual({ state: null, effects: [] });
		});
	});

	describe("runtime_restarted", () => {
		const restarted = (taskSessionRunning: boolean, worktreeClean: boolean): AgentReviewEvent => ({
			type: "runtime_restarted",
			taskSessionRunning,
			worktreeClean,
		});

		it("re-enqueues a reviewing task with the same round", () => {
			const { state, effects } = reduce(makeState({ status: "reviewing", round: 2 }), restarted(false, false));
			expect(state).toMatchObject({ status: "queued", round: 2 });
			expect(effects).toEqual([{ type: "enqueue_review" }]);
		});

		it("completes Done for committing with a clean worktree", () => {
			const { effects } = reduce(makeState({ status: "committing" }), restarted(true, true));
			expect(effects).toEqual([{ type: "complete_done" }]);
		});

		it("re-runs the commit step for committing with a dirty worktree", () => {
			const { state, effects } = reduce(makeState({ status: "committing" }), restarted(false, false));
			expect(state).toMatchObject({ status: "committing" });
			expect(effects).toEqual([{ type: "send_commit", action: "commit" }]);
		});

		it("sends fixing without a running session to user_review", () => {
			const { state, effects } = reduce(makeState({ status: "fixing", round: 1 }), restarted(false, false), {
				columnId: "in_progress",
			});
			expect(state).toMatchObject({ status: "needs_user", reason: "task_agent_not_running" });
			expect(effects).toEqual([{ type: "move_card", to: "user_review" }]);
		});

		it("leaves fixing alone while the session still runs", () => {
			const before = makeState({ status: "fixing", round: 1 });
			expect(reduce(before, restarted(true, false), { columnId: "in_progress" })).toEqual({
				state: before,
				effects: [],
			});
		});
	});
});
