import type { RuntimeAgentReviewReason, RuntimeAgentReviewState } from "@/runtime/types";

const REASON_LABELS: Record<RuntimeAgentReviewReason, string> = {
	round_limit: "3 fix rounds used",
	cannot_verify: "Reviewer could not verify",
	reviewer_crashed: "Reviewer crashed",
	reviewer_timeout: "Reviewer timed out",
	reviewer_bad_output: "Reviewer gave no valid result",
	reviewer_modified_worktree: "Reviewer modified the worktree",
	reviewer_agent_unavailable: "Reviewer agent not available",
	task_agent_not_running: "Task agent not running",
	commit_failed: "Commit failed",
};

export function getAgentReviewBadgeLabel(state: RuntimeAgentReviewState): string {
	switch (state.status) {
		case "queued":
			return "Review queued";
		case "reviewing":
			return `Reviewing ${state.round + 1}/4`;
		case "fixing":
			return `Fixing ${state.round}/3`;
		case "committing":
			return "Committing";
		case "passed":
			return "Agent review passed";
		case "no_changes":
			return "No changes, not reviewed";
		case "needs_user":
			return state.reason ? REASON_LABELS[state.reason] : "Needs your review";
	}
}

export function AgentReviewStatusBadge({
	state,
}: {
	state: RuntimeAgentReviewState | undefined;
}): React.ReactElement | null {
	if (!state) return null;
	const color =
		state.status === "needs_user"
			? "text-status-orange"
			: state.status === "passed"
				? "text-status-green"
				: "text-text-secondary";
	return (
		<span className={`inline-flex items-center rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] ${color}`}>
			{getAgentReviewBadgeLabel(state)}
		</span>
	);
}
