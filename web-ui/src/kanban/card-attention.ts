import { getHandOffCount, getReviewRoundCap, isHandOffAgentId, MAX_HAND_OFFS } from "@runtime-hand-off-cap";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardColumnId } from "@/types";
import { isPermissionWaitActivity } from "../../../src/core/permission-hook";

export function getCardAttention(
	card: BoardCard,
	columnId: BoardColumnId,
	summary: RuntimeTaskSessionSummary | undefined,
): "owner" | "sidebar" | "approval" | null {
	if (card.waitingReport) return null;
	if (card.blockedReport && (columnId === "in_progress" || columnId === "review")) return "owner";
	if (columnId === "in_progress") {
		return isPermissionWaitActivity(summary?.latestHookActivity) ? "approval" : null;
	}
	if (columnId !== "review") return null;
	if (card.agentReviewEnabled !== true) return "owner";
	if (card.quotaBlockedAt !== undefined) return "sidebar";
	if (!summary || summary.state === "idle" || summary.state === "interrupted") return "owner";

	const canHandOff = isHandOffAgentId(card.agentId) && getHandOffCount(card) < MAX_HAND_OFFS;
	const crashed =
		summary.state === "failed" ||
		summary.reviewReason === "error" ||
		(summary.reviewReason === "exit" && summary.exitCode !== null && summary.exitCode !== 0);
	if (crashed) return summary.agentId === card.agentId && canHandOff ? "sidebar" : "owner";
	const queued =
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "hook" || (summary.reviewReason === "exit" && summary.exitCode === 0));
	return queued && ((card.reviewRound ?? 0) < getReviewRoundCap(card) || canHandOff) ? "sidebar" : "owner";
}

export function sortCardsByAttention(
	cards: BoardCard[],
	columnId: BoardColumnId,
	sessions: Record<string, RuntimeTaskSessionSummary>,
): BoardCard[] {
	const priority = (card: BoardCard) => {
		const attention = getCardAttention(card, columnId, sessions[card.id]);
		return attention === "owner" || attention === "approval" ? 0 : 1;
	};
	return [...cards].sort((a, b) => priority(a) - priority(b));
}
