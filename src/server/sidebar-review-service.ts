import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import { getHandOffCount, getReviewRoundCap, isHandOffAgentId, MAX_HAND_OFFS } from "../core/hand-off-cap";
import { createHomeAgentSessionId, isHomeAgentSessionId } from "../core/home-agent-session";
import { recordTaskHistoryEvent } from "../state/task-history";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { sendPromptToSession } from "../terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import { createSidebarReviewQueue } from "./sidebar-review-queue";
import { detectUsageLimit } from "./usage-limit-detector";

export interface CreateSidebarReviewServiceDependencies {
	workspaceId: string;
	workspacePath: string;
	terminalManager: TerminalSessionManager;
	clineService: ClineTaskSessionService;
	loadRuntimeConfig: () => Promise<RuntimeConfigState>;
	handOffTask: (
		taskId: string,
		reason: string,
	) => Promise<{ ok: boolean; error?: string | null; fromAgentId?: string; toAgentId?: string }>;
	retryQuotaBlockedTask: (
		taskId: string,
		reason: string,
	) => Promise<{ ok: boolean; error?: string | null; fromAgentId?: string; toAgentId?: string }>;
	broadcastStateUpdated: () => Promise<void> | void;
	warn: (message: string) => void;
	now?: () => number;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
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
	const nudgedTaskIds = new Set<string>();
	const quotaWarnedTaskIds = new Set<string>();
	const processingTaskIds = new Set<string>();
	const now = deps.now ?? Date.now;
	const recordHistory = async (taskId: string, event: Parameters<typeof recordTaskHistoryEvent>[2]): Promise<void> => {
		try {
			await recordTaskHistoryEvent(deps.workspaceId, taskId, event);
		} catch (error) {
			deps.warn(`[sidebar-review] Could not record task history for ${taskId}: ${errorMessage(error)}`);
		}
	};
	let sidebarIdleAvailable = false;
	let started = false;
	let retryInterval: ReturnType<typeof setInterval> | undefined;
	const unsubscribers: Array<() => void> = [];
	const retryQuotaBlockedTasks = async (): Promise<void> => {
		try {
			const state = await loadWorkspaceState(deps.workspacePath);
			for (const column of state.board.columns) {
				if (column.id !== "review") continue;
				for (const card of column.cards) {
					if (
						card.agentReviewEnabled !== true ||
						card.quotaBlockedAt === undefined ||
						now() - card.quotaBlockedAt < 3600000 ||
						processingTaskIds.has(card.id)
					)
						continue;
					try {
						const retryReason =
							"Every agent hit their usage limit. Kanban waited 1 hour and is retrying with you.";
						const result = await deps.retryQuotaBlockedTask(card.id, retryReason);
						if (result.ok) {
							const retryAgentId = result.toAgentId ?? card.agentId;
							if (retryAgentId) {
								await recordHistory(card.id, {
									type: "retry",
									agentId: retryAgentId,
									round: card.reviewRound,
									detail: retryReason,
								});
							}
							continue;
						}
						deps.warn(
							`[sidebar-review] Could not retry quota-blocked task ${card.id}: ${result.error ?? "unknown error"}`,
						);
						const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
							const found = findCard(current.board, card.id);
							if (!found || found.columnId !== "review" || found.card.quotaBlockedAt !== card.quotaBlockedAt)
								return { board: current.board, value: null, save: false };
							const board = {
								...current.board,
								columns: current.board.columns.map((column) => ({
									...column,
									cards: column.cards.map((candidate) =>
										candidate.id === card.id ? { ...candidate, quotaBlockedAt: now() } : candidate,
									),
								})),
							};
							return { board, value: true, save: true };
						});
						if (mutation.saved) await deps.broadcastStateUpdated();
					} catch (error) {
						deps.warn(`[sidebar-review] Could not retry quota-blocked task ${card.id}: ${errorMessage(error)}`);
					}
				}
			}
		} catch (error) {
			deps.warn(`[sidebar-review] Could not check quota-blocked tasks: ${errorMessage(error)}`);
		}
	};
	const clearQuotaBlockedAt = async (taskId: string): Promise<void> => {
		const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
			if (findCard(current.board, taskId)?.card.quotaBlockedAt === undefined)
				return { board: current.board, value: null, save: false };
			const board = {
				...current.board,
				columns: current.board.columns.map((column) => ({
					...column,
					cards: column.cards.map((card) => {
						if (card.id !== taskId) return card;
						const { quotaBlockedAt: _quotaBlockedAt, ...updatedCard } = card;
						return updatedCard;
					}),
				})),
			};
			return { board, value: true, save: true };
		});
		if (mutation.saved) await deps.broadcastStateUpdated();
	};

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

	const processReviewableSummary = async (
		summary: RuntimeTaskSessionSummary,
		card: RuntimeBoardCard,
	): Promise<void> => {
		if (processingTaskIds.has(summary.taskId)) return;
		processingTaskIds.add(summary.taskId);
		try {
			if (isHandOffAgentId(card.agentId)) {
				try {
					const terminal = await deps.terminalManager.getRestoreSnapshot(summary.taskId);
					const phrase = terminal ? detectUsageLimit(terminal.snapshot) : null;
					if (phrase) {
						if (getHandOffCount(card) >= MAX_HAND_OFFS) {
							const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
								const currentCard = findCard(current.board, summary.taskId)?.card;
								if (!currentCard || currentCard.quotaBlockedAt !== undefined)
									return { board: current.board, value: null, save: false };
								const board = {
									...current.board,
									columns: current.board.columns.map((column) => ({
										...column,
										cards: column.cards.map((candidate) =>
											candidate.id === summary.taskId ? { ...candidate, quotaBlockedAt: now() } : candidate,
										),
									})),
								};
								return { board, value: true, save: true };
							});
							if (mutation.saved) {
								if (card.agentId) {
									await recordHistory(summary.taskId, {
										type: "quota_blocked",
										agentId: card.agentId,
										round: card.reviewRound,
									});
								}
								await deps.broadcastStateUpdated();
							}
							if (!quotaWarnedTaskIds.has(summary.taskId)) {
								quotaWarnedTaskIds.add(summary.taskId);
								deps.warn(
									`[sidebar-review] Task ${summary.taskId}: both agents hit their usage limit; leaving it in Review`,
								);
							}
							return;
						}
						const reason = `The previous agent hit its usage limit ("${phrase}").`;
						const result = await deps.handOffTask(summary.taskId, reason);
						if (result.ok) {
							if (card.agentId) {
								await recordHistory(summary.taskId, {
									type: "handoff",
									agentId: result.fromAgentId ?? card.agentId,
									toAgentId: result.toAgentId,
									round: card.reviewRound,
									detail: reason,
								});
							}
							return;
						}
						deps.warn(
							`[sidebar-review] Could not hand off task ${summary.taskId}: ${result.error ?? "unknown error"}`,
						);
					}
				} catch (error) {
					deps.warn(`[sidebar-review] Could not check usage limit for ${summary.taskId}: ${errorMessage(error)}`);
				}
			}
			if (card.quotaBlockedAt !== undefined) await clearQuotaBlockedAt(summary.taskId);
			if ((card.reviewRound ?? 0) < getReviewRoundCap(card)) {
				try {
					const { path: worktreePath } = await getTaskWorkspacePathInfo({
						cwd: deps.workspacePath,
						taskId: summary.taskId,
						baseRef: card.baseRef,
					});
					const status = await runGit(worktreePath, ["status", "--porcelain"]);
					if (!status.ok) throw new Error(status.error || status.stdout);
					const commits = await runGit(worktreePath, ["rev-list", "--count", `${card.baseRef}..HEAD`]);
					if (!commits.ok) throw new Error(commits.error || commits.stdout);
					if (!status.stdout && commits.stdout === "0" && !nudgedTaskIds.has(summary.taskId)) {
						nudgedTaskIds.add(summary.taskId);
						const result = await sendPromptToSession({
							sessionId: summary.taskId,
							agentId: summary.agentId,
							prompt: `[Kanban] No changes found in your worktree (git status is clean and there are no commits since ${card.baseRef}). The task is not done. Make the changes the task asks for, run every acceptance command, and paste the output.`,
							terminalManager: deps.terminalManager,
							clineService: deps.clineService,
						});
						if (!result.ok)
							deps.warn(`[sidebar-review] Could not nudge task ${summary.taskId}: session is not running`);
						return;
					}
				} catch (error) {
					deps.warn(`[sidebar-review] Could not check worktree for ${summary.taskId}: ${errorMessage(error)}`);
				}
			}
			nudgedTaskIds.delete(summary.taskId);
			const mutation = await mutateWorkspaceState(deps.workspacePath, (current) => {
				const currentCard = findCard(current.board, summary.taskId)?.card;
				if (!currentCard || (currentCard.reviewRound ?? 0) !== (card.reviewRound ?? 0)) {
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
		} finally {
			processingTaskIds.delete(summary.taskId);
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
			if (
				isHomeAgentSessionId(summary.taskId) ||
				!previous ||
				previous.state === "failed" ||
				previous.reviewReason === "error" ||
				(previous.reviewReason === "exit" && previous.exitCode !== 0)
			) {
				return;
			}
			const crashed =
				summary.state === "failed" ||
				summary.reviewReason === "error" ||
				(summary.reviewReason === "exit" && summary.exitCode !== 0);
			const reviewable =
				summary.state === "awaiting_review" &&
				(summary.reviewReason === "hook" || (summary.reviewReason === "exit" && summary.exitCode === 0));
			if (!crashed && (previous.state === "awaiting_review" || !reviewable)) {
				return;
			}
			const state = await loadWorkspaceState(deps.workspacePath);
			const found = findCard(state.board, summary.taskId);
			if (!found || found.card.agentReviewEnabled !== true || found.columnId === "trash") {
				return;
			}
			if (crashed) {
				if (getHandOffCount(found.card) < MAX_HAND_OFFS && isHandOffAgentId(found.card.agentId)) {
					const reason = `The previous agent stopped with an error (exit code ${summary.exitCode ?? "unknown"}).`;
					const result = await deps.handOffTask(summary.taskId, reason);
					if (!result.ok) {
						deps.warn(
							`[sidebar-review] Could not hand off task ${summary.taskId}: ${result.error ?? "unknown error"}`,
						);
					} else {
						if (found.card.agentId) {
							await recordHistory(summary.taskId, {
								type: "handoff",
								agentId: result.fromAgentId ?? found.card.agentId,
								toAgentId: result.toAgentId,
								round: found.card.reviewRound,
								detail: reason,
							});
						}
						return;
					}
				}
			}
			if (!reviewable) return;
			await processReviewableSummary(summary, found.card);
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
						card.quotaBlockedAt === undefined &&
						card.agentReviewEnabled &&
						(card.reviewRound ?? 0) >= 1 &&
						(card.reviewRound ?? 0) <= getReviewRoundCap(card)
					) {
						queue.restoreTask(card, card.reviewRound ?? 0);
					} else if (column.id === "trash" || !card.agentReviewEnabled) {
						queue.onTaskDone(card.id);
					}
				}
			}
			await retryQuotaBlockedTasks();
			retryInterval = (deps.setInterval ?? setInterval)(() => void retryQuotaBlockedTasks(), 300000);
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
						if (column.id === "trash" || !card.agentReviewEnabled) {
							nudgedTaskIds.delete(card.id);
							quotaWarnedTaskIds.delete(card.id);
							if ((card.reviewRound ?? 0) !== 0 || getHandOffCount(card) !== 0 || card.handedOff === true) {
								changed = true;
								const { handedOff: _legacyHandedOff, ...resetCard } = card;
								const { quotaBlockedAt: _quotaBlockedAt, ...clearedQuotaCard } = resetCard;
								return { ...clearedQuotaCard, reviewRound: 0, handOffCount: 0 };
							}
						}
						if ((column.id !== "review" || !card.agentReviewEnabled) && card.quotaBlockedAt !== undefined) {
							changed = true;
							const { quotaBlockedAt: _quotaBlockedAt, ...updatedCard } = card;
							return updatedCard;
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
			const summaries = [...deps.terminalManager.listSummaries(), ...deps.clineService.listSummaries()];
			for (const column of mutation.value) {
				if (column.id !== "review") continue;
				for (const card of column.cards) {
					if (card.agentReviewEnabled !== true || (card.reviewRound ?? 0) !== 0) continue;
					const summary = summaries.find(
						(candidate) => candidate.taskId === card.id && candidate.state === "awaiting_review",
					);
					if (summary) await processReviewableSummary(summary, card);
				}
			}
			if (mutation.saved) await deps.broadcastStateUpdated();
		},
		dispose: () => {
			if (retryInterval) (deps.clearInterval ?? clearInterval)(retryInterval);
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		},
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
