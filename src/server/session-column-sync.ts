import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { isTaskWaiting } from "../core/waiting-report";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { clearWaitingReportOnSummary } from "./blocked-report-clearing";

interface SessionColumnSyncDependencies {
	workspaceId: string;
	workspacePath: string;
	terminalManager: Pick<TerminalSessionManager, "onSummary" | "listSummaries">;
	clineService: { onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void };
	onBoardMoved: () => Promise<void>;
	warn: (message: string) => void;
}

export interface SessionSummaryEvent {
	summary: RuntimeTaskSessionSummary;
	previous: RuntimeTaskSessionSummary | undefined;
	waitingReportCleared: boolean;
}

export function createSessionColumnSync(deps: SessionColumnSyncDependencies) {
	const previousSummaries = new Map<string, RuntimeTaskSessionSummary>();
	const listeners = new Set<(event: SessionSummaryEvent) => void>();
	const unsubscribers: Array<() => void> = [];
	let started = false;
	let pending = Promise.resolve();

	const moveForSummary = async (summary: RuntimeTaskSessionSummary): Promise<void> => {
		if (isHomeAgentSessionId(summary.taskId)) return;
		if (summary.state !== "awaiting_review" && summary.state !== "running") return;
		const fromColumn = summary.state === "awaiting_review" ? "in_progress" : "review";
		const toColumn = summary.state === "awaiting_review" ? "review" : "in_progress";
		const mutation = await mutateWorkspaceState(deps.workspacePath, (state) => {
			if (
				!started ||
				!state.board.columns.some(
					(column) =>
						column.id === fromColumn &&
						column.cards.some(
							(card) =>
								card.id === summary.taskId && (summary.state !== "awaiting_review" || !isTaskWaiting(card)),
						),
				)
			) {
				return { board: state.board, value: null, save: false };
			}
			const moved = moveTaskToColumn(state.board, summary.taskId, toColumn);
			return {
				board: {
					...moved.board,
					columns: moved.board.columns.map((column) =>
						column.id === toColumn && moved.task
							? {
									...column,
									cards: [moved.task, ...column.cards.filter((card) => card.id !== summary.taskId)],
								}
							: column,
					),
				},
				value: null,
				save: moved.moved,
			};
		});
		if (started && mutation.saved) await deps.onBoardMoved();
	};

	const handleSummary = (summary: RuntimeTaskSessionSummary): void => {
		pending = pending
			.then(async () => {
				if (!started) return;
				const previous = previousSummaries.get(summary.taskId);
				if (previous && previous.updatedAt > summary.updatedAt) return;
				previousSummaries.set(summary.taskId, summary);
				const waitingReportCleared = await clearWaitingReportOnSummary(
					deps.workspacePath,
					{ summary, previous },
					() => started,
				);
				if (waitingReportCleared) {
					if (started) await deps.onBoardMoved();
				}
				if (previous?.state !== summary.state) await moveForSummary(summary);
				for (const listener of listeners) listener({ summary, previous, waitingReportCleared });
			})
			.catch((error: unknown) => {
				deps.warn(
					`[session-column-sync] Could not process ${deps.workspaceId}/${summary.taskId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	};

	const stop = (): void => {
		started = false;
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		previousSummaries.clear();
		listeners.clear();
	};

	return {
		start: async (): Promise<void> => {
			if (started) return await pending;
			started = true;
			pending = pending.then(async () => {
				const state = await loadWorkspaceState(deps.workspacePath);
				if (!started) return;
				for (const summary of [...Object.values(state.sessions), ...deps.terminalManager.listSummaries()]) {
					previousSummaries.set(summary.taskId, summary);
				}
				for (const summary of previousSummaries.values()) {
					if (!started) return;
					if (
						await clearWaitingReportOnSummary(deps.workspacePath, { summary, previous: undefined }, () => started)
					) {
						if (started) await deps.onBoardMoved();
					}
					if (summary.state === "awaiting_review") await moveForSummary(summary);
				}
			});
			unsubscribers.push(deps.terminalManager.onSummary(handleSummary), deps.clineService.onSummary(handleSummary));
			try {
				await pending;
			} catch (error) {
				stop();
				throw error;
			}
		},
		stop,
		onSummary: (listener: (event: SessionSummaryEvent) => void): (() => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
