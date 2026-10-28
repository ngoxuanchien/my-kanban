import type {
	RuntimeAgentId,
	RuntimeAgentReviewReason,
	RuntimeAgentReviewResult,
	RuntimeAgentReviewState,
	RuntimeBoardColumnId,
	RuntimeTaskAutoReviewMode,
} from "../core/api-contract";

export const AGENT_REVIEW_MAX_FIX_ROUNDS = 3;

export type ReviewerOutcome =
	| { kind: "result"; result: RuntimeAgentReviewResult }
	| { kind: "timeout" }
	| { kind: "crashed"; error: string }
	| { kind: "bad_output"; error: string }
	| { kind: "modified_worktree"; paths: string[] }
	| { kind: "unavailable"; reason: string };

export type AgentReviewEvent =
	| { type: "turn_ended"; hasChanges: boolean; fingerprint: string }
	| {
			type: "reviewer_finished";
			outcome: ReviewerOutcome;
			fingerprint: string;
			reviewerAgentId: RuntimeAgentId;
			now: number;
	  }
	// The review run threw before it could report an outcome.
	| { type: "review_failed"; error: string }
	| { type: "fix_send_failed" }
	| { type: "commit_finished"; ok: true; commitHash: string; prUrl: string | null }
	| { type: "commit_finished"; ok: false }
	| { type: "user_input" }
	| { type: "moved_by_user"; to: RuntimeBoardColumnId }
	| { type: "toggled_off" }
	| { type: "runtime_restarted"; taskSessionRunning: boolean; worktreeClean: boolean };

export type AgentReviewEffect =
	| { type: "move_card"; to: RuntimeBoardColumnId }
	| { type: "enqueue_review" }
	| { type: "cancel_review" }
	// The service wraps fixPrompt with buildFixPromptMessage before sending it.
	| { type: "send_fix"; fixPrompt: string; round: number }
	| { type: "send_commit"; action: RuntimeTaskAutoReviewMode }
	| { type: "complete_done" };

export interface AgentReviewReducerInput {
	state: RuntimeAgentReviewState | null;
	columnId: RuntimeBoardColumnId;
	autoReviewEnabled: boolean;
	autoReviewMode: RuntimeTaskAutoReviewMode;
	now: number;
	event: AgentReviewEvent;
}

export interface AgentReviewReducerOutput {
	state: RuntimeAgentReviewState | null;
	effects: AgentReviewEffect[];
}

function createInitialState(now: number): RuntimeAgentReviewState {
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
		updatedAt: now,
	};
}

function isReviewActive(state: RuntimeAgentReviewState | null): boolean {
	return state?.status === "queued" || state?.status === "reviewing";
}

function toNeedsUser(
	state: RuntimeAgentReviewState,
	reason: RuntimeAgentReviewReason,
	reasonDetail: string | null,
	now: number,
): AgentReviewReducerOutput {
	return {
		state: { ...state, status: "needs_user", reason, reasonDetail, updatedAt: now },
		effects: [{ type: "move_card", to: "user_review" }],
	};
}

function reduceReviewerOutcome(
	state: RuntimeAgentReviewState,
	outcome: ReviewerOutcome,
	autoReviewEnabled: boolean,
	autoReviewMode: RuntimeTaskAutoReviewMode,
	now: number,
): AgentReviewReducerOutput {
	switch (outcome.kind) {
		case "timeout":
			return toNeedsUser(state, "reviewer_timeout", null, now);
		case "crashed":
			return toNeedsUser(state, "reviewer_crashed", outcome.error, now);
		case "bad_output":
			return toNeedsUser(state, "reviewer_bad_output", outcome.error, now);
		case "unavailable":
			return toNeedsUser(state, "reviewer_agent_unavailable", outcome.reason, now);
		case "modified_worktree":
			return toNeedsUser(state, "reviewer_modified_worktree", outcome.paths.join("\n"), now);
		case "result":
			break;
	}
	const { result } = outcome;
	const withResult: RuntimeAgentReviewState = { ...state, lastResult: result, summary: result.summary };
	if (result.verdict === "fail") {
		if (result.fixPrompt === null) {
			return toNeedsUser(withResult, "reviewer_bad_output", "fail verdict without a fixPrompt", now);
		}
		if (state.round >= AGENT_REVIEW_MAX_FIX_ROUNDS) {
			return toNeedsUser(withResult, "round_limit", null, now);
		}
		const round = state.round + 1;
		return {
			state: {
				...withResult,
				status: "fixing",
				round,
				reason: null,
				reasonDetail: null,
				fixPrompts: [...state.fixPrompts, result.fixPrompt],
				updatedAt: now,
			},
			effects: [{ type: "send_fix", fixPrompt: result.fixPrompt, round }],
		};
	}
	// A pass without a verified app run is not a pass (spec 4.3).
	if (result.verdict === "cannot_verify" || !result.appVerified) {
		return toNeedsUser(withResult, "cannot_verify", null, now);
	}
	// Q1 (a): always commit after a pass. Auto-review settings only choose commit vs PR.
	return {
		state: { ...withResult, status: "committing", reason: null, reasonDetail: null, updatedAt: now },
		effects: [{ type: "send_commit", action: autoReviewEnabled ? autoReviewMode : "commit" }],
	};
}

export function reduceAgentReview(input: AgentReviewReducerInput): AgentReviewReducerOutput {
	const { state, columnId, now, event } = input;
	const unchanged: AgentReviewReducerOutput = { state, effects: [] };

	switch (event.type) {
		case "turn_ended": {
			if (columnId !== "in_progress" && columnId !== "review") {
				return unchanged;
			}
			if (state?.status === "committing") {
				return unchanged;
			}
			const moveToReview: AgentReviewEffect[] =
				columnId === "in_progress" ? [{ type: "move_card", to: "review" }] : [];
			// "passed" and "no_changes" are stable until the reviewed content changes (spec 4.5).
			if (
				(state?.status === "passed" || state?.status === "no_changes") &&
				state.fingerprint === event.fingerprint
			) {
				return { state, effects: moveToReview };
			}
			const base = state ?? createInitialState(now);
			const reset = { reason: null, reasonDetail: null, updatedAt: now };
			if (!event.hasChanges) {
				return {
					state: { ...base, ...reset, status: "no_changes", fingerprint: event.fingerprint },
					effects: moveToReview,
				};
			}
			return {
				state: { ...base, ...reset, status: "queued" },
				effects: [...moveToReview, { type: "enqueue_review" }],
			};
		}
		case "reviewer_finished": {
			// A result for a cancelled run, or for a card that left Review, is stale.
			if (!state || !isReviewActive(state) || columnId !== "review") {
				return unchanged;
			}
			const reviewed: RuntimeAgentReviewState = {
				...state,
				fingerprint: event.fingerprint,
				meta: {
					commitHash: null,
					prUrl: null,
					rounds: state.round,
					reviewerAgentId: event.reviewerAgentId,
					reviewedAt: event.now,
				},
			};
			return reduceReviewerOutcome(reviewed, event.outcome, input.autoReviewEnabled, input.autoReviewMode, now);
		}
		case "review_failed":
			if (!state || !isReviewActive(state) || columnId !== "review") {
				return unchanged;
			}
			return toNeedsUser(state, "reviewer_crashed", event.error, now);
		case "fix_send_failed":
			return state ? toNeedsUser(state, "task_agent_not_running", null, now) : unchanged;
		case "commit_finished": {
			if (state?.status !== "committing") {
				return unchanged;
			}
			if (!event.ok) {
				return toNeedsUser(state, "commit_failed", null, now);
			}
			return {
				state: {
					...state,
					status: "passed",
					meta: state.meta && {
						...state.meta,
						commitHash: event.commitHash,
						prUrl: event.prUrl,
						rounds: state.round,
					},
					updatedAt: now,
				},
				effects: [{ type: "complete_done" }],
			};
		}
		case "user_input": {
			if (!state) {
				return unchanged;
			}
			const reset: RuntimeAgentReviewState = { ...state, round: 0, fixPrompts: [], updatedAt: now };
			if (!isReviewActive(state)) {
				return { state: reset, effects: [] };
			}
			// The running review is stale. Re-run it rather than wait for a turn end: keystrokes
			// that never start a turn would otherwise leave the card "reviewing" with no reviewer.
			return {
				state: { ...reset, status: "queued" },
				effects: [{ type: "cancel_review" }, { type: "enqueue_review" }],
			};
		}
		case "moved_by_user": {
			if (!state) {
				return unchanged;
			}
			if (columnId === "user_review") {
				const reset: RuntimeAgentReviewState = { ...state, round: 0, fixPrompts: [], updatedAt: now };
				if (event.to === "review") {
					return {
						state: { ...reset, status: "queued", reason: null, reasonDetail: null },
						effects: [{ type: "enqueue_review" }],
					};
				}
				return { state: reset, effects: [] };
			}
			if (event.to !== "review" && isReviewActive(state)) {
				return { state, effects: [{ type: "cancel_review" }] };
			}
			return unchanged;
		}
		case "toggled_off":
			return { state: null, effects: isReviewActive(state) ? [{ type: "cancel_review" }] : [] };
		case "runtime_restarted": {
			if (!state) {
				return unchanged;
			}
			switch (state.status) {
				case "queued":
				case "reviewing":
					// The queue lives in memory, so re-run the review with the same round.
					return { state: { ...state, status: "queued", updatedAt: now }, effects: [{ type: "enqueue_review" }] };
				case "committing":
					if (event.worktreeClean) {
						return {
							state: { ...state, status: "passed", updatedAt: now },
							effects: [{ type: "complete_done" }],
						};
					}
					// The commit step died with the runtime: run it again.
					return {
						state: { ...state, updatedAt: now },
						effects: [{ type: "send_commit", action: input.autoReviewEnabled ? input.autoReviewMode : "commit" }],
					};
				case "fixing":
					return event.taskSessionRunning ? unchanged : toNeedsUser(state, "task_agent_not_running", null, now);
				default:
					return unchanged;
			}
		}
	}
}
