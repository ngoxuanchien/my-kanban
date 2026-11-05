import type { RuntimeBoardCard, RuntimeBoardData } from "./api-contract";

export const WAITING_REASON_MAX_LENGTH = 500;

export function isTaskWaiting(card: Pick<RuntimeBoardCard, "waitingReport">): boolean {
	return card.waitingReport !== undefined;
}

export function withoutWaitingReport(card: RuntimeBoardCard): RuntimeBoardCard {
	const { waitingReport: _waitingReport, ...rest } = card;
	return rest;
}

export function clearWaitingReport(board: RuntimeBoardData, taskId: string): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === taskId ? withoutWaitingReport(card) : card)),
		})),
	};
}
