import { mutateWorkspaceState } from "../state/workspace-state";
import type { RuntimeBoardCard, RuntimeBoardData, RuntimeTaskSessionSummary } from "./api-contract";

export const BLOCKED_QUESTION_MAX_LENGTH = 500;

export function isTaskBlocked(card: Pick<RuntimeBoardCard, "blockedReport">): boolean {
	return card.blockedReport !== undefined;
}

export function withoutBlockedReport(card: RuntimeBoardCard): RuntimeBoardCard {
	const { blockedReport: _blockedReport, ...rest } = card;
	return rest;
}

export function clearBlockedReport(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === taskId ? withoutBlockedReport(card) : card)),
		})),
	};
}

// Clears the report only on a real transition into "running" that happened after it was reported,
// so a session that keeps running while the agent files the report does not wipe it.
export async function clearBlockedReportOnRun(
	workspacePath: string,
	event: { summary: RuntimeTaskSessionSummary; previous: RuntimeTaskSessionSummary | undefined },
): Promise<boolean> {
	const { summary, previous } = event;
	if (summary.state !== "running" || !previous || previous.state === "running") return false;
	const mutation = await mutateWorkspaceState(workspacePath, (state) => {
		const reportedAt = state.board.columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === summary.taskId)?.blockedReport?.reportedAt;
		if (reportedAt === undefined || summary.updatedAt <= reportedAt) {
			return { board: state.board, value: null, save: false };
		}
		return { board: clearBlockedReport(state.board, summary.taskId), value: null, save: true };
	});
	return mutation.saved;
}
