import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { clearBlockedReport } from "../core/blocked-report";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { clearWaitingReport } from "../core/waiting-report";
import { mutateWorkspaceState } from "../state/workspace-state";

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

// An awaiting_review session can still be live; exit/error summaries end the wait too.
export async function clearWaitingReportOnSummary(
	workspacePath: string,
	event: { summary: RuntimeTaskSessionSummary; previous: RuntimeTaskSessionSummary | undefined },
	isActive: () => boolean = () => true,
): Promise<boolean> {
	const { summary, previous } = event;
	const resumed = summary.state === "running" && previous !== undefined && previous.state !== "running";
	const exited =
		(summary.state !== "running" && summary.state !== "awaiting_review") ||
		(summary.state === "awaiting_review" && (summary.reviewReason === "exit" || summary.reviewReason === "error"));
	if (!resumed && !exited) return false;
	const mutation = await mutateWorkspaceState(workspacePath, (state) => {
		const report = state.board.columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === summary.taskId)?.waitingReport;
		if (!isActive() || !report || summary.updatedAt <= report.reportedAt) {
			return { board: state.board, value: null, save: false };
		}
		let board = clearWaitingReport(state.board, summary.taskId);
		if (
			exited &&
			board.columns.some(
				(column) => column.id === "in_progress" && column.cards.some((card) => card.id === summary.taskId),
			)
		) {
			board = moveTaskToColumn(board, summary.taskId, "review").board;
		}
		return { board, value: null, save: true };
	});
	return mutation.saved;
}
