import type { RuntimeBoardCard, RuntimeBoardData } from "./api-contract";

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
