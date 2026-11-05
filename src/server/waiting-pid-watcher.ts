import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { clearWaitingReport } from "../core/waiting-report";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import type { SendPromptToSessionResult, sendPromptToSession } from "../terminal/send-prompt-to-session";

interface WaitingPidWatcherDependencies {
	workspacePath: string;
	listSummaries: () => RuntimeTaskSessionSummary[];
	sendPrompt: (
		input: Pick<Parameters<typeof sendPromptToSession>[0], "sessionId" | "prompt" | "agentId">,
	) => Promise<SendPromptToSessionResult>;
	broadcastStateUpdated: () => Promise<void> | void;
	warn: (message: string) => void;
	isPidAlive?: (pid: number) => boolean;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			if (error.code === "ESRCH") return false;
			if (error.code === "EPERM") return true;
		}
		throw error;
	}
}

export function createWaitingPidWatcher(deps: WaitingPidWatcherDependencies) {
	const alive = deps.isPidAlive ?? isPidAlive;
	let timer: ReturnType<typeof setInterval> | undefined;
	let started = false;
	let checking = false;

	const check = async (): Promise<void> => {
		if (!started || checking) return;
		checking = true;
		try {
			const state = await loadWorkspaceState(deps.workspacePath);
			for (const column of state.board.columns) {
				for (const card of column.cards) {
					const report = card.waitingReport;
					if (!started || !report || report.pid === undefined) continue;
					try {
						if (alive(report.pid)) continue;
						const summary = deps.listSummaries().find((candidate) => candidate.taskId === card.id);
						const live =
							summary?.pid != null && (summary.state === "running" || summary.state === "awaiting_review");
						const delivered =
							live &&
							(
								await deps.sendPrompt({
									sessionId: card.id,
									agentId: summary.agentId ?? card.agentId ?? null,
									prompt: `[Kanban] Background job ${report.pid} exited. Check its output and continue the task.`,
								})
							).ok;
						const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
							const currentColumn = current.board.columns.find((candidate) =>
								candidate.cards.some((task) => task.id === card.id),
							);
							const currentReport = currentColumn?.cards.find((task) => task.id === card.id)?.waitingReport;
							if (
								!started ||
								!currentReport ||
								currentReport.reportedAt !== report.reportedAt ||
								currentReport.pid !== report.pid ||
								currentReport.reason !== report.reason
							) {
								return { board: current.board, value: null, save: false };
							}
							let board = clearWaitingReport(current.board, card.id);
							if (!delivered && currentColumn?.id === "in_progress")
								board = moveTaskToColumn(board, card.id, "review").board;
							return { board, value: null, save: true };
						});
						if (started && mutation.saved) await deps.broadcastStateUpdated();
					} catch (error) {
						deps.warn(
							`[waiting-pid] Could not check ${card.id}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}
		} catch (error) {
			deps.warn(`[waiting-pid] Could not load workspace: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			checking = false;
		}
	};

	return {
		start: async (): Promise<void> => {
			if (started) return;
			started = true;
			await check();
			if (!started) return;
			timer = setInterval(() => {
				void check();
			}, 30_000);
			timer.unref();
		},
		stop: (): void => {
			started = false;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		},
	};
}
