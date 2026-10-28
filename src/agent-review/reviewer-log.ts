// Keeps the tail of a reviewer run's output so the card detail view can show it.
import type { RuntimeAgentId, RuntimeAgentReviewLog } from "../core/api-contract";

export const REVIEWER_LOG_MAX_CHARS = 64 * 1024;

export function createReviewerLog(reviewerAgentId: RuntimeAgentId, round: number, now: number): RuntimeAgentReviewLog {
	return { reviewerAgentId, round, startedAt: now, finishedAt: null, output: "", truncated: false };
}

export function appendReviewerLog(
	log: RuntimeAgentReviewLog,
	chunk: string,
	maxChars = REVIEWER_LOG_MAX_CHARS,
): RuntimeAgentReviewLog {
	const output = log.output + chunk;
	if (output.length <= maxChars) {
		return { ...log, output };
	}
	return { ...log, output: output.slice(-maxChars), truncated: true };
}
