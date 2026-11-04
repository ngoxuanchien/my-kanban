import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { clearBlockedReport } from "../core/blocked-report";
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
