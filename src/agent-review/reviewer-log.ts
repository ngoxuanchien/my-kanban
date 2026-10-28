// Metadata of a task's latest reviewer run, for the card detail view. The output itself is the
// reviewer's PTY session ("agent-review:<taskId>"), shown in the browser terminal.
import type { RuntimeAgentId, RuntimeAgentReviewLog } from "../core/api-contract";

export function createReviewerLog(reviewerAgentId: RuntimeAgentId, round: number, now: number): RuntimeAgentReviewLog {
	return { reviewerAgentId, round, startedAt: now, finishedAt: null };
}
