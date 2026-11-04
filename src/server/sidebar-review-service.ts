import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../core/api-contract";
import { isTaskBlocked } from "../core/blocked-report";
import { resolveEffectiveTaskAgentId } from "../core/effective-task-agent";
import { getHandOffCount, getReviewRoundCap, isHandOffAgentId, MAX_HAND_OFFS } from "../core/hand-off-cap";
import { createHomeAgentSessionId, isHomeAgentSessionId } from "../core/home-agent-session";
import { isPermissionWaitActivity } from "../core/permission-hook";
import { recordTaskHistoryEvent } from "../state/task-history";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { sendPromptToSession } from "../terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { runGit } from "../workspace/git-utils";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";
import {
	findAntigravityLogUsageLimit,
	readAntigravityLogs as readAntigravityLogsDefault,
} from "./antigravity-log-usage-limit";
import { readCodexModelNotFound } from "./codex-log-model-error";
import { findOpenCodeLogUsageLimit, readOpenCodeLogTail } from "./opencode-log-usage-limit";
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
		expectedFromAgentId?: "codex" | "opencode" | "antigravity",
	) => Promise<{ ok: boolean; error?: string | null; fromAgentId?: string; toAgentId?: string }>;
	retryQuotaBlockedTask: (
		taskId: string,
		reason: string,
	) => Promise<{ ok: boolean; error?: string | null; fromAgentId?: string; toAgentId?: string }>;
	broadcastStateUpdated: () => Promise<void> | void;
	warn: (message: string) => void;
	readOpenCodeLog?: () => Promise<string | null>;
	readAntigravityLogs?: typeof readAntigravityLogsDefault;
	readCodexModelError?: typeof readCodexModelNotFound;
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
const QUOTA_NUDGE_WAIT_MS = 300000;
const SCREEN_QUOTA_QUIET_MS = 30000;

interface QuotaNudge {
	sentAt: number;
	turn: number | null;
	isRunning: boolean;
	warned: boolean;
}

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
	const quotaNudges = new Map<string, QuotaNudge>();
	const quotaWarnedTaskIds = new Set<string>();
	const processingTaskIds = new Set<string>();
	const now = deps.now ?? Date.now;
	const readOpenCodeLog = deps.readOpenCodeLog ?? readOpenCodeLogTail;
	const readAntigravityLogs = deps.readAntigravityLogs ?? readAntigravityLogsDefault;
	const readCodexModelError = deps.readCodexModelError ?? readCodexModelNotFound;
	const findUsageLimit = async (
		summary: RuntimeTaskSessionSummary,
		card: RuntimeBoardCard,
		screenText: string,
	): Promise<string | null> => {
		const isRunning = summary.state === "running";
		const idleSince = summary.lastOutputAt ?? summary.startedAt;
		const screenPhrase =
			!isRunning || (idleSince !== null && now() - idleSince >= SCREEN_QUOTA_QUIET_MS)
				? detectUsageLimit(screenText)
				: null;
		if (screenPhrase) return screenPhrase;
		let logSource = "usage";
		try {
			const selectedAgentId =
				card.agentId == null && summary.agentId == null
					? (await deps.loadRuntimeConfig()).selectedAgentId
					: undefined;
			const agentId = resolveEffectiveTaskAgentId(card.agentId, summary.agentId, selectedAgentId);
			if (agentId !== "opencode" && agentId !== "antigravity" && agentId !== "codex") return null;
			logSource = agentId === "opencode" ? "OpenCode" : agentId === "antigravity" ? "Antigravity" : "Codex";
			const { path: worktreePath } = await getTaskWorkspacePathInfo({
				cwd: deps.workspacePath,
				taskId: summary.taskId,
				baseRef: card.baseRef,
			});
			if (agentId === "opencode") {
				const logText = await readOpenCodeLog();
				return logText
					? findOpenCodeLogUsageLimit(logText, { worktreePath, sinceMs: summary.startedAt ?? 0 })
					: null;
			}
			if (agentId === "codex") return await readCodexModelError({ worktreePath, sinceMs: summary.startedAt ?? 0 });
			return findAntigravityLogUsageLimit(await readAntigravityLogs(), {
				worktreePath,
				sinceMs: summary.startedAt ?? 0,
			});
		} catch (error) {
			deps.warn(`[sidebar-review] Could not read ${logSource} log for ${summary.taskId}: ${errorMessage(error)}`);
			return null;
		}
	};
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
						isTaskBlocked(card) ||
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
	const handleUsageLimit = async (
		summary: RuntimeTaskSessionSummary,
		card: RuntimeBoardCard,
		phrase: string | null,
		isRunning: boolean,
	): Promise<boolean> => {
		const turn = summary.latestTurnCheckpoint?.turn ?? summary.startedAt;
		let nudge = quotaNudges.get(summary.taskId);
		if (nudge && nudge.turn !== turn) {
			quotaNudges.delete(summary.taskId);
			nudge = undefined;
		}
		const idleSince = summary.lastOutputAt ?? summary.startedAt;
		const stillStuck =
			Boolean(phrase) || (isRunning && idleSince !== null && now() - idleSince >= QUOTA_NUDGE_WAIT_MS);
		if (!nudge && !phrase) {
			if (!stillStuck) return false;
			const sent =
				isRunning && (summary.agentId ?? card.agentId) === "antigravity"
					? Boolean(deps.terminalManager.writeInput(summary.taskId, Buffer.from("\r")))
					: (
							await sendPromptToSession({
								sessionId: summary.taskId,
								agentId: summary.agentId ?? card.agentId ?? null,
								prompt: "continue",
								terminalManager: deps.terminalManager,
								clineService: deps.clineService,
							})
						).ok;
			if (!sent) return false;
			nudge = { sentAt: now(), turn, isRunning, warned: false };
			quotaNudges.set(summary.taskId, nudge);
			const { selectedAgentId } = await deps.loadRuntimeConfig();
			const agentId = resolveEffectiveTaskAgentId(card.agentId, summary.agentId, selectedAgentId);
			if (agentId)
				await recordHistory(summary.taskId, {
					type: "retry",
					agentId,
					round: card.reviewRound,
					detail: "continue sent (usage limit or no output for 5 min)",
				});
			return true;
		}
		if (nudge && !phrase && now() - nudge.sentAt < QUOTA_NUDGE_WAIT_MS) return true;
		if (!stillStuck) {
			quotaNudges.delete(summary.taskId);
			return false;
		}
		if (!isHandOffAgentId(card.agentId)) {
			if (nudge && !nudge.warned) {
				nudge.warned = true;
				deps.warn(
					`[sidebar-review] Task ${summary.taskId}: still stuck after continue; no handoff agent is available`,
				);
			} else if (!nudge && phrase && !quotaWarnedTaskIds.has(summary.taskId)) {
				quotaWarnedTaskIds.add(summary.taskId);
				deps.warn(`[sidebar-review] Task ${summary.taskId}: usage limit detected; no handoff agent is available`);
			}
			return true;
		}
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
				if (card.agentId)
					await recordHistory(summary.taskId, {
						type: "quota_blocked",
						agentId: card.agentId,
						round: card.reviewRound,
					});
				await deps.broadcastStateUpdated();
			}
			if (!quotaWarnedTaskIds.has(summary.taskId)) {
				quotaWarnedTaskIds.add(summary.taskId);
				deps.warn(
					!phrase
						? `[sidebar-review] Task ${summary.taskId}: no output after continue; leaving it in Review`
						: `[sidebar-review] Task ${summary.taskId}: both agents hit their usage limit; leaving it in Review`,
				);
			}
		} else {
			const isCodexModelError = phrase === "model_not_found";
			const detail = !phrase
				? "The previous agent produced no terminal output for 5 minutes after continue."
				: `The previous agent hit its usage limit ("${phrase}").`;
			const reason = isCodexModelError
				? "Codex cannot use its configured model (model_not_found)."
				: phrase
					? "The previous agent hit its usage limit."
					: detail;
			const result = await deps.handOffTask(summary.taskId, reason);
			if (result.ok) {
				if (card.agentId) {
					await recordHistory(summary.taskId, {
						type: "handoff",
						agentId: result.fromAgentId ?? card.agentId,
						toAgentId: result.toAgentId,
						round: card.reviewRound,
						detail: isCodexModelError ? reason : detail,
					});
					if (isCodexModelError)
						await recordHistory(summary.taskId, {
							type: "comment",
							agentId: card.agentId,
							detail: 'Change "model" in ~/.codex/config.toml to one your account supports.',
						});
				}
			} else {
				deps.warn(`[sidebar-review] Could not hand off task ${summary.taskId}: ${result.error ?? "unknown error"}`);
				quotaNudges.delete(summary.taskId);
				return false;
			}
		}
		quotaNudges.delete(summary.taskId);
		return true;
	};
	const checkStuckTasks = async (): Promise<void> => {
		await retryQuotaBlockedTasks();
		const state = await loadWorkspaceState(deps.workspacePath);
		const summaries = deps.terminalManager.listSummaries();
		for (const column of state.board.columns) {
			if (column.id !== "in_progress" && column.id !== "review") continue;
			for (const card of column.cards) {
				if (card.agentReviewEnabled !== true || isTaskBlocked(card) || processingTaskIds.has(card.id)) continue;
				const summary = summaries.find((candidate) => candidate.taskId === card.id);
				if (!summary || summary.agentId === "cline" || card.agentId === "cline") continue;
				if (summary.state === "running") {
					let terminal: Awaited<ReturnType<TerminalSessionManager["getRestoreSnapshot"]>>;
					try {
						terminal = await deps.terminalManager.getRestoreSnapshot(card.id);
					} catch (error) {
						deps.warn(`[sidebar-review] Could not check usage limit for ${card.id}: ${errorMessage(error)}`);
						continue;
					}
					const phrase = terminal ? await findUsageLimit(summary, card, terminal.snapshot) : null;
					const idleSince = summary.lastOutputAt ?? summary.startedAt;
					const silent = idleSince !== null && now() - idleSince >= QUOTA_NUDGE_WAIT_MS;
					if (
						phrase ||
						(!isPermissionWaitActivity(summary.latestHookActivity) && (silent || quotaNudges.has(card.id)))
					) {
						processingTaskIds.add(card.id);
						try {
							await handleUsageLimit(summary, card, phrase, true);
						} finally {
							processingTaskIds.delete(card.id);
						}
					}
				} else if (summary.state === "awaiting_review" && isHandOffAgentId(card.agentId)) {
					let terminal: Awaited<ReturnType<TerminalSessionManager["getRestoreSnapshot"]>>;
					try {
						terminal = await deps.terminalManager.getRestoreSnapshot(card.id);
					} catch (error) {
						deps.warn(`[sidebar-review] Could not check usage limit for ${card.id}: ${errorMessage(error)}`);
						continue;
					}
					const phrase = terminal ? await findUsageLimit(summary, card, terminal.snapshot) : null;
					if (phrase || quotaNudges.has(card.id)) await processReviewableSummary(summary, card);
				}
			}
		}
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
		if (isTaskBlocked(card) || processingTaskIds.has(summary.taskId)) return;
		processingTaskIds.add(summary.taskId);
		try {
			const completedRunningNudge = quotaNudges.get(summary.taskId)?.isRunning === true;
			if (completedRunningNudge) quotaNudges.delete(summary.taskId);
			if (!completedRunningNudge && isHandOffAgentId(card.agentId)) {
				try {
					const terminal = await deps.terminalManager.getRestoreSnapshot(summary.taskId);
					const phrase = terminal ? await findUsageLimit(summary, card, terminal.snapshot) : null;
					if (
						(phrase || quotaNudges.has(summary.taskId)) &&
						(await handleUsageLimit(summary, card, phrase, false))
					)
						return;
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
			if (
				!found ||
				found.card.agentReviewEnabled !== true ||
				isTaskBlocked(found.card) ||
				found.columnId === "trash"
			) {
				return;
			}
			if (crashed) {
				if (summary.agentId != null && summary.agentId !== found.card.agentId) {
					return;
				}
				if (getHandOffCount(found.card) < MAX_HAND_OFFS && isHandOffAgentId(found.card.agentId)) {
					const reason = `The previous agent stopped with an error (exit code ${summary.exitCode ?? "unknown"}).`;
					const result = await deps.handOffTask(
						summary.taskId,
						reason,
						summary.agentId != null && isHandOffAgentId(summary.agentId) ? summary.agentId : undefined,
					);
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
						quotaNudges.delete(summary.taskId);
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
			retryInterval = (deps.setInterval ?? setInterval)(() => void checkStuckTasks(), QUOTA_NUDGE_WAIT_MS);
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
