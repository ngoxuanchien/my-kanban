import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import { createHomeAgentSessionId, isHomeAgentSessionId } from "../core/home-agent-session";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { sendPromptToSession } from "../terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { createSidebarReviewQueue } from "./sidebar-review-queue";

export interface CreateSidebarReviewServiceDependencies {
	workspaceId: string;
	workspacePath: string;
	terminalManager: TerminalSessionManager;
	clineService: ClineTaskSessionService;
	loadRuntimeConfig: () => Promise<RuntimeConfigState>;
	broadcastStateUpdated: () => Promise<void> | void;
	warn: (message: string) => void;
}

export interface SidebarReviewService {
	start: () => Promise<void>;
	notifyBoardChanged: () => Promise<void>;
	dispose: () => void;
}

const reviewQueue = createSidebarReviewQueue;

function isSidebarIdle(summary: RuntimeTaskSessionSummary | undefined): boolean {
	return Boolean(summary && summary.pid !== null && (summary.state === "awaiting_review" || summary.state === "idle"));
}

function findCard(board: { columns: Array<{ id: string; cards: RuntimeBoardCard[] }> }, taskId: string) {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

export function createSidebarReviewService(deps: CreateSidebarReviewServiceDependencies): SidebarReviewService {
	const queue = reviewQueue();
	const previousSummaries = new Map<string, RuntimeTaskSessionSummary>();
	let sidebarIdleAvailable = false;
	let started = false;
	const unsubscribers: Array<() => void> = [];

	const deliverNext = async (): Promise<void> => {
		if (!sidebarIdleAvailable) {
			return;
		}
		const prompt = queue.onSidebarIdle();
		if (!prompt) {
			return;
		}
		sidebarIdleAvailable = false;
		try {
			const { selectedAgentId: agentId } = await deps.loadRuntimeConfig();
			const sessionId = createHomeAgentSessionId(deps.workspaceId, agentId);
			const result = await sendPromptToSession({
				sessionId,
				prompt,
				agentId,
				terminalManager: deps.terminalManager,
				clineService: deps.clineService,
			});
			if (!result.ok) {
				deps.warn(`[sidebar-review] Could not wake sidebar for ${deps.workspacePath}: session is not running`);
				return;
			}
			queue.onTaskDelivered(prompt);
		} catch (error) {
			deps.warn(`[sidebar-review] Could not wake sidebar for ${deps.workspacePath}: ${errorMessage(error)}`);
		}
	};

	const handleSummary = (summary: RuntimeTaskSessionSummary): void => {
		const previous = previousSummaries.get(summary.taskId);
		previousSummaries.set(summary.taskId, summary);
		void (async () => {
			const { selectedAgentId } = await deps.loadRuntimeConfig();
			const sidebarId = createHomeAgentSessionId(deps.workspaceId, selectedAgentId);
			if (summary.taskId === sidebarId) {
				const wasIdle = isSidebarIdle(previous);
				const isIdle = isSidebarIdle(summary);
				if (!isIdle) {
					sidebarIdleAvailable = false;
				} else if (!wasIdle) {
					sidebarIdleAvailable = true;
					await deliverNext();
				}
				return;
			}
			if (isHomeAgentSessionId(summary.taskId) || !previous || previous.state === "awaiting_review") {
				return;
			}
			if (
				summary.state !== "awaiting_review" ||
				(summary.reviewReason !== "hook" && !(summary.reviewReason === "exit" && summary.exitCode === 0))
			) {
				return;
			}
			const state = await loadWorkspaceState(deps.workspacePath);
			const found = findCard(state.board, summary.taskId);
			if (!found || found.card.agentReviewEnabled !== true || found.columnId === "trash") {
				return;
			}
			const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
				const currentCard = findCard(current.board, summary.taskId)?.card;
				if (!currentCard) {
					return { board: current.board, value: null, save: false };
				}
				const review = queue.onTaskTurnEnd(currentCard);
				if (!review) return { board: current.board, value: null, save: false };
				const round = review.round;
				const board = {
					...current.board,
					columns: current.board.columns.map((column) => ({
						...column,
						cards: column.cards.map((card) =>
							card.id === summary.taskId ? { ...card, reviewRound: round } : card,
						),
					})),
				};
				return { board, value: { ...currentCard, reviewRound: round }, save: true };
			});
			if (mutation.saved && mutation.value) {
				await deps.broadcastStateUpdated();
				await deliverNext();
			}
		})().catch((error: unknown) => {
			deps.warn(`[sidebar-review] Could not process session ${summary.taskId}: ${errorMessage(error)}`);
		});
	};

	return {
		start: async () => {
			if (started) return;
			started = true;
			const state = await loadWorkspaceState(deps.workspacePath);
			for (const column of state.board.columns) {
				for (const card of column.cards) {
					if (
						column.id === "review" &&
						card.agentReviewEnabled &&
						(card.reviewRound ?? 0) >= 1 &&
						(card.reviewRound ?? 0) <= 3
					) {
						queue.restoreTask(card, card.reviewRound ?? 0);
					} else if (column.id === "trash" || !card.agentReviewEnabled) {
						queue.onTaskDone(card.id);
					}
				}
			}
			for (const summary of [...deps.terminalManager.listSummaries(), ...deps.clineService.listSummaries()]) {
				previousSummaries.set(summary.taskId, summary);
			}
			const config = await deps.loadRuntimeConfig();
			const sidebarId = createHomeAgentSessionId(deps.workspaceId, config.selectedAgentId);
			sidebarIdleAvailable = isSidebarIdle(previousSummaries.get(sidebarId));
			unsubscribers.push(deps.terminalManager.onSummary(handleSummary), deps.clineService.onSummary(handleSummary));
			await deliverNext();
		},
		notifyBoardChanged: async () => {
			const mutation = await mutateWorkspaceState(deps.workspacePath, (state) => {
				let changed = false;
				const columns = state.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => {
						if ((column.id === "trash" || !card.agentReviewEnabled) && (card.reviewRound ?? 0) !== 0) {
							changed = true;
							return { ...card, reviewRound: 0 };
						}
						return card;
					}),
				}));
				return { board: { ...state.board, columns }, value: columns, save: changed };
			});
			for (const column of mutation.value) {
				for (const card of column.cards) {
					if (column.id === "trash" || !card.agentReviewEnabled) queue.onTaskDone(card.id);
				}
			}
			if (mutation.saved) await deps.broadcastStateUpdated();
		},
		dispose: () => {
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
