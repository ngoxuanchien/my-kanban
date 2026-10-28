import { describe, expect, it } from "vitest";

import { getAgentReviewBadgeLabel } from "@/components/agent-review-status-badge";
import type { RuntimeAgentReviewState } from "@/runtime/types";

function state(
	status: RuntimeAgentReviewState["status"],
	round = 0,
	reason: RuntimeAgentReviewState["reason"] = null,
): RuntimeAgentReviewState {
	return {
		status,
		round,
		reason,
		reasonDetail: null,
		fingerprint: null,
		lastResult: null,
		fixPrompts: [],
		summary: null,
		meta: null,
		updatedAt: 1,
	};
}

describe("getAgentReviewBadgeLabel", () => {
	it.each([
		[state("queued"), "Review queued"],
		[state("reviewing", 1), "Reviewing 2/4"],
		[state("fixing", 1), "Fixing 1/3"],
		[state("committing"), "Committing"],
		[state("passed"), "Agent review passed"],
		[state("no_changes"), "No changes, not reviewed"],
		...[
			"round_limit|3 fix rounds used",
			"cannot_verify|Reviewer could not verify",
			"reviewer_crashed|Reviewer crashed",
			"reviewer_timeout|Reviewer timed out",
			"reviewer_bad_output|Reviewer gave no valid result",
			"reviewer_modified_worktree|Reviewer modified the worktree",
			"reviewer_agent_unavailable|Reviewer agent not available",
			"task_agent_not_running|Task agent not running",
			"commit_failed|Commit failed",
		].map((entry) => {
			const [reason, label] = entry.split("|") as [RuntimeAgentReviewState["reason"] & string, string];
			return [state("needs_user", 0, reason), label] as const;
		}),
	] as const)("labels %o", (value, label) => expect(getAgentReviewBadgeLabel(value)).toBe(label));
});
