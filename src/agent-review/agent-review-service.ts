// One agent-review loop per workspace: watches task-session summaries, drives
// reduceAgentReview, runs the reviewer (one at a time) and saves state on the card.
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import { getRuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeAgentReviewLog,
	RuntimeAgentReviewState,
	RuntimeAgentReviewStatus,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { buildTaskGitActionPrompt } from "../core/task-git-action-prompt";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { isBinaryAvailableOnPath } from "../terminal/command-discovery";
import type { TerminalSessionManager } from "../terminal/session-manager";
import {
	AgentReviewGitError,
	captureWorktreeSnapshot,
	computeTaskReviewFingerprint,
	diffWorktreeSnapshots,
	findCommitWithReviewFingerprint,
	type WorktreeSnapshot,
} from "../workspace/agent-review-git";
import { type CompleteTaskToDoneDeps, completeTaskToDone } from "../workspace/complete-task-to-done";
import { runGit } from "../workspace/git-utils";
import {
	AGENT_REVIEW_MAX_FIX_ROUNDS,
	type AgentReviewEffect,
	type AgentReviewEvent,
	type AgentReviewReducerOutput,
	type ReviewerOutcome,
	reduceAgentReview,
} from "./agent-review-reducer";
import { appendReviewerLog, createReviewerLog } from "./reviewer-log";
import { parseReviewerOutput } from "./reviewer-output";
import { buildFixPromptMessage, buildReviewerPrompt } from "./reviewer-prompt";
import { type ReviewerRunHandle, type ReviewerRunOutcome, startReviewerRun } from "./reviewer-runner";
import { sendPromptToTask } from "./send-prompt-to-task";
import { AGENT_REVIEW_SESSION_KEY_PREFIX, classifyTurnEnd } from "./task-session-signals";

export const REVIEWER_RUN_TIMEOUT_MS = 20 * 60_000;
export const COMMIT_STEP_TIMEOUT_MS = 10 * 60_000;
// A prompt can reach the terminal without starting a turn (e.g. OpenCode ran it as a shell command),
// so a fix/commit prompt whose turn has not started by then fails instead of waiting for a turn end.
export const TASK_TURN_START_TIMEOUT_MS = 60_000;

const PR_URL_PATTERN = /https:\/\/github\.com\/\S+?\/pull\/\d+/g;

export interface AgentReviewServiceDeps {
	workspaceId: string;
	repoPath: string;
	terminalManager: TerminalSessionManager;
	clineService: ClineTaskSessionService;
	loadRuntimeConfig(): Promise<RuntimeConfigState>;
	resolveTaskCwd(taskId: string, baseRef: string): Promise<string>;
	doneDeps: CompleteTaskToDoneDeps;
	/** Relaunches a task agent that is not running (after a restart) with `prompt`. Resolves true when it started. */
	resumeTask(card: RuntimeBoardCard, prompt: string): Promise<boolean>;
	broadcastStateUpdated(): Promise<void>;
	/** Reports errors the loop recovers from (it keeps running). */
	warn?: (message: string) => void;
	/** Test seam. */
	startReviewerRun?: typeof startReviewerRun;
	now?: () => number;
}

export interface AgentReviewService {
	/** Subscribes to session summaries, then recovers reviews that were in flight before a restart. */
	start(): Promise<void>;
	notifyUserInput(taskId: string): void;
	/** Call after any browser/CLI save so user moves, toggles and deletions are seen. */
	notifyBoardChanged(): Promise<void>;
	/** Output of the task's latest reviewer run, live while it runs. */
	getReviewerLog(taskId: string): RuntimeAgentReviewLog | null;
	dispose(): Promise<void>;
}

interface CardLocation {
	card: RuntimeBoardCard;
	columnId: RuntimeBoardColumnId;
}

interface KnownCard {
	columnId: RuntimeBoardColumnId;
	enabled: boolean;
}

interface ActiveRun {
	taskId: string;
	handle: ReviewerRunHandle | null;
	cancelled: boolean;
}

interface PreparedRun {
	round: number;
	reviewerAgentId: RuntimeAgentId;
	fingerprint: string;
	cwd: string;
	before: WorktreeSnapshot | null;
	failure: string | null;
}

interface ApplyEventOptions {
	/** Column handed to the reducer; moved_by_user passes the column the card came from. */
	columnId?: RuntimeBoardColumnId;
	/** Drops the event when it returns false for the card read at write time. */
	guard?: (card: RuntimeBoardCard) => boolean;
}

function findCard(board: RuntimeBoardData, taskId: string): CardLocation | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

function withAgentReview(card: RuntimeBoardCard, state: RuntimeAgentReviewState | null): RuntimeBoardCard {
	const { agentReview: _previous, ...rest } = card;
	return state ? { ...rest, agentReview: state } : rest;
}

function replaceCard(board: RuntimeBoardData, nextCard: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === nextCard.id ? nextCard : card)),
		})),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAgentInstalled(agentId: RuntimeAgentId): boolean {
	// Cline runs in-process through the SDK (same rule as agent-registry).
	if (agentId === "cline") {
		return true;
	}
	const entry = getRuntimeAgentCatalogEntry(agentId);
	return entry ? isBinaryAvailableOnPath(entry.binary) : false;
}

function turnNotStartedDetail(prompt: string): string {
	return `The task agent did not start working within ${TASK_TURN_START_TIMEOUT_MS / 1000}s of the ${prompt} prompt. Check its terminal: the prompt may not have been submitted.`;
}

function findLastPrUrl(message: string | null | undefined): string | null {
	return message?.match(PR_URL_PATTERN)?.at(-1) ?? null;
}

export function createAgentReviewService(deps: AgentReviewServiceDeps): AgentReviewService {
	const now = deps.now ?? Date.now;
	const runReviewer = deps.startReviewerRun ?? startReviewerRun;
	const warn = deps.warn ?? (() => {});
	const knownCards = new Map<string, KnownCard>();
	const lastSessionKinds = new Map<string, string>();
	const reviewQueue: string[] = [];
	const commitTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const turnStartTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const reviewerLogs = new Map<string, RuntimeAgentReviewLog>();
	let activeRun: ActiveRun | null = null;
	let unsubscribes: Array<() => void> = [];
	let disposed = false;
	let chain: Promise<unknown> = Promise.resolve();

	// Board writes and effects run one at a time so events never interleave. Reviewer runs
	// wait outside this chain, so a cancel can get in while a reviewer is running.
	const serialize = <T>(work: () => Promise<T>): Promise<T | null> => {
		const next = chain.then(() => (disposed ? null : work()));
		chain = next.catch((error: unknown) => {
			warn(`[agent-review] ${deps.workspaceId}: ${errorMessage(error)}`);
		});
		return next;
	};

	const rememberCard = (board: RuntimeBoardData, taskId: string) => {
		const location = findCard(board, taskId);
		if (location) {
			knownCards.set(taskId, { columnId: location.columnId, enabled: location.card.agentReviewEnabled === true });
		} else {
			knownCards.delete(taskId);
		}
	};

	const readCard = async (taskId: string): Promise<CardLocation | null> =>
		findCard((await loadWorkspaceState(deps.repoPath)).board, taskId);

	const resolveTaskAgentId = (card: RuntimeBoardCard, config: RuntimeConfigState): RuntimeAgentId =>
		card.agentId ?? config.selectedAgentId;

	const sendToTask = async (card: RuntimeBoardCard, prompt: string) => {
		const config = await deps.loadRuntimeConfig();
		return await sendPromptToTask({
			taskId: card.id,
			prompt,
			agentId: resolveTaskAgentId(card, config),
			terminalManager: deps.terminalManager,
			clineService: deps.clineService,
		});
	};

	async function applyEvent(taskId: string, event: AgentReviewEvent, options: ApplyEventOptions = {}): Promise<void> {
		const mutation = await mutateWorkspaceState<{ card: RuntimeBoardCard; output: AgentReviewReducerOutput } | null>(
			deps.repoPath,
			(workspace) => {
				const location = findCard(workspace.board, taskId);
				const skip = { board: workspace.board, value: null, save: false };
				if (!location) {
					return skip;
				}
				const { card } = location;
				if (card.agentReviewEnabled !== true && event.type !== "toggled_off") {
					return skip;
				}
				if (options.guard && !options.guard(card)) {
					return skip;
				}
				const previousState = card.agentReview ?? null;
				const output = reduceAgentReview({
					state: previousState,
					columnId: options.columnId ?? location.columnId,
					autoReviewEnabled: card.autoReviewEnabled === true,
					autoReviewMode: card.autoReviewMode ?? "commit",
					now: now(),
					event,
				});
				const moves = output.effects.filter(
					(effect): effect is Extract<AgentReviewEffect, { type: "move_card" }> => effect.type === "move_card",
				);
				// complete_done saves the final state in the same write that moves the card to Done.
				const deferWrite = output.effects.some((effect) => effect.type === "complete_done");
				if (deferWrite || (output.state === previousState && moves.length === 0)) {
					return { board: workspace.board, value: { card, output }, save: false };
				}
				let board = replaceCard(workspace.board, withAgentReview(card, output.state));
				for (const move of moves) {
					board = moveTaskToColumn(board, taskId, move.to, now()).board;
				}
				return { board, value: { card, output } };
			},
		);
		if (!mutation.value) {
			return;
		}
		rememberCard(mutation.state.board, taskId);
		if (mutation.saved) {
			await deps.broadcastStateUpdated();
		}
		for (const effect of mutation.value.output.effects) {
			await runEffect(mutation.value.card, mutation.value.output.state, effect);
		}
	}

	async function runEffect(
		card: RuntimeBoardCard,
		state: RuntimeAgentReviewState | null,
		effect: AgentReviewEffect,
	): Promise<void> {
		switch (effect.type) {
			case "move_card":
				// Applied in the same board write as the state.
				return;
			case "enqueue_review":
				enqueueReview(card.id);
				return;
			case "cancel_review":
				cancelReview(card.id);
				return;
			case "send_fix": {
				const message = buildFixPromptMessage({
					fixPrompt: effect.fixPrompt,
					round: effect.round,
					maxRounds: AGENT_REVIEW_MAX_FIX_ROUNDS,
				});
				if (!(await sendToTask(card, message)).ok) {
					await applyEvent(card.id, { type: "fix_send_failed" });
					return;
				}
				watchTurnStart(card.id, "fixing", {
					type: "fix_send_failed",
					detail: turnNotStartedDetail("fix"),
				});
				return;
			}
			case "send_commit": {
				const config = await deps.loadRuntimeConfig();
				const prompt = buildTaskGitActionPrompt({
					action: effect.action,
					baseRef: card.baseRef,
					templates: config,
				});
				// After a restart the task agent is not running; relaunch it with the commit prompt.
				if (!(await sendToTask(card, prompt)).ok && !(await deps.resumeTask(card, prompt))) {
					await applyEvent(card.id, { type: "commit_finished", ok: false });
					return;
				}
				clearCommitTimer(card.id);
				commitTimers.set(
					card.id,
					setTimeout(() => {
						commitTimers.delete(card.id);
						void serialize(() => applyEvent(card.id, { type: "commit_finished", ok: false }));
					}, COMMIT_STEP_TIMEOUT_MS),
				);
				watchTurnStart(card.id, "committing", {
					type: "commit_finished",
					ok: false,
					detail: turnNotStartedDetail(effect.action === "pr" ? "PR" : "commit"),
				});
				return;
			}
			case "complete_done": {
				const result = await completeTaskToDone({
					repoPath: deps.repoPath,
					taskId: card.id,
					deps: deps.doneDeps,
					beforeMove: (current) => (current.agentReviewEnabled ? withAgentReview(current, state) : current),
				});
				rememberCard(result.state.board, card.id);
				return;
			}
		}
	}

	function watchTurnStart(taskId: string, status: RuntimeAgentReviewStatus, onTimeout: AgentReviewEvent): void {
		clearTurnStartTimer(taskId);
		turnStartTimers.set(
			taskId,
			setTimeout(() => {
				turnStartTimers.delete(taskId);
				clearCommitTimer(taskId);
				void serialize(() =>
					applyEvent(taskId, onTimeout, { guard: (card) => card.agentReview?.status === status }),
				);
			}, TASK_TURN_START_TIMEOUT_MS),
		);
	}

	function clearTurnStartTimer(taskId: string): void {
		const timer = turnStartTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			turnStartTimers.delete(taskId);
		}
	}

	function clearCommitTimer(taskId: string): void {
		const timer = commitTimers.get(taskId);
		if (timer) {
			clearTimeout(timer);
			commitTimers.delete(taskId);
		}
	}

	/** The commit the commit step made, or null when it did not land. */
	async function readCommitResult(card: RuntimeBoardCard): Promise<string | null> {
		// The commit prompt cherry-picks onto baseRef, after which the task worktree may be gone.
		const fingerprint = card.agentReview?.fingerprint;
		if (fingerprint) {
			try {
				const landed = await findCommitWithReviewFingerprint({
					cwd: deps.repoPath,
					ref: card.baseRef,
					fingerprint,
				});
				if (landed) {
					return landed;
				}
			} catch {}
		}
		try {
			const cwd = await deps.resolveTaskCwd(card.id, card.baseRef);
			const status = await runGit(cwd, ["status", "--porcelain"]);
			if (!status.ok || status.stdout !== "") {
				return null;
			}
			const head = await runGit(cwd, ["rev-parse", "HEAD"]);
			return head.ok ? head.stdout : null;
		} catch {
			return null;
		}
	}

	async function finishCommitStep(taskId: string, summary: RuntimeTaskSessionSummary): Promise<void> {
		clearCommitTimer(taskId);
		const location = await readCard(taskId);
		if (!location) {
			return;
		}
		const commitHash = await readCommitResult(location.card);
		await applyEvent(
			taskId,
			commitHash
				? {
						type: "commit_finished",
						ok: true,
						commitHash,
						prUrl: findLastPrUrl(summary.latestHookActivity?.finalMessage),
					}
				: { type: "commit_finished", ok: false },
		);
	}

	async function handleTurnEnd(taskId: string, summary: RuntimeTaskSessionSummary): Promise<void> {
		if (commitTimers.has(taskId)) {
			await finishCommitStep(taskId, summary);
			return;
		}
		const location = await readCard(taskId);
		if (
			location?.card.agentReviewEnabled !== true ||
			(location.columnId !== "in_progress" && location.columnId !== "review")
		) {
			return;
		}
		const { card } = location;
		// If the diff cannot be computed, queue the review anyway: the run hits the same
		// git error and reports it as reviewer_crashed, which goes to user_review.
		let diff = { hasChanges: true, fingerprint: "" };
		try {
			const cwd = await deps.resolveTaskCwd(taskId, card.baseRef);
			diff = await computeTaskReviewFingerprint({ cwd, baseRef: card.baseRef });
		} catch {}
		await applyEvent(taskId, { type: "turn_ended", ...diff });
	}

	async function handleSummary(summary: RuntimeTaskSessionSummary): Promise<void> {
		// An agent that exits (or whose session is reset) after the commit turn never reports a turn end.
		const stopped = summary.state === "idle" || summary.state === "failed" || summary.state === "interrupted";
		const kind = summary.state === "running" ? "running" : stopped ? "stopped" : classifyTurnEnd(summary);
		const previousKind = lastSessionKinds.get(summary.taskId);
		lastSessionKinds.set(summary.taskId, kind);
		if (kind === previousKind) {
			return;
		}
		if (kind === "running") {
			clearTurnStartTimer(summary.taskId);
			await applyEvent(summary.taskId, { type: "task_running" });
		} else if (
			kind === "turn_end" ||
			// Only once the commit turn has started: a session can report "idle" while it is being relaunched.
			(kind === "stopped" && commitTimers.has(summary.taskId) && !turnStartTimers.has(summary.taskId))
		) {
			await handleTurnEnd(summary.taskId, summary);
		}
	}

	const onSummary = (summary: RuntimeTaskSessionSummary) => {
		if (summary.taskId.startsWith(AGENT_REVIEW_SESSION_KEY_PREFIX)) {
			return;
		}
		void serialize(() => handleSummary(summary));
	};

	function enqueueReview(taskId: string): void {
		// A new request means a running review of this task is checking stale content, and its
		// result would be dropped by the round/status guard. Replace it.
		if (activeRun?.taskId === taskId && !activeRun.cancelled) {
			activeRun.cancelled = true;
			activeRun.handle?.cancel();
		}
		if (!reviewQueue.includes(taskId)) {
			reviewQueue.push(taskId);
		}
		pumpQueue();
	}

	function cancelReview(taskId: string): void {
		const queuedIndex = reviewQueue.indexOf(taskId);
		if (queuedIndex !== -1) {
			reviewQueue.splice(queuedIndex, 1);
		}
		if (activeRun?.taskId === taskId && !activeRun.cancelled) {
			activeRun.cancelled = true;
			activeRun.handle?.cancel();
		}
	}

	function pumpQueue(): void {
		if (activeRun || disposed) {
			return;
		}
		const taskId = reviewQueue.shift();
		if (!taskId) {
			return;
		}
		const run: ActiveRun = { taskId, handle: null, cancelled: false };
		activeRun = run;
		void executeReview(run)
			.catch(async (error: unknown) => {
				warn(`[agent-review] ${deps.workspaceId}: review of ${taskId} failed: ${errorMessage(error)}`);
				// Never leave the card "queued"/"reviewing" with no reviewer behind it.
				if (!run.cancelled) {
					await serialize(() => applyEvent(taskId, { type: "review_failed", error: errorMessage(error) })).catch(
						() => {},
					);
				}
			})
			.finally(() => {
				activeRun = null;
				pumpQueue();
			});
	}

	async function executeReview(run: ActiveRun): Promise<void> {
		const prepared = await serialize(() => prepareReview(run));
		if (!prepared) {
			return;
		}
		const runOutcome = run.handle ? await run.handle.done : null;
		await serialize(async () => {
			if (run.cancelled) {
				return;
			}
			const outcome = await toReviewerOutcome(prepared, runOutcome);
			if (!outcome) {
				return;
			}
			await applyEvent(
				run.taskId,
				{
					type: "reviewer_finished",
					outcome,
					fingerprint: prepared.fingerprint,
					reviewerAgentId: prepared.reviewerAgentId,
					now: now(),
				},
				// A result for an older round (user input, a later review) is stale.
				{ guard: (card) => card.agentReview?.status === "reviewing" && card.agentReview.round === prepared.round },
			);
		});
	}

	async function prepareReview(run: ActiveRun): Promise<PreparedRun | null> {
		if (run.cancelled) {
			return null;
		}
		const marked = await mutateWorkspaceState<RuntimeBoardCard | null>(deps.repoPath, (workspace) => {
			const location = findCard(workspace.board, run.taskId);
			const state = location?.card.agentReview;
			if (
				location?.card.agentReviewEnabled !== true ||
				location.columnId !== "review" ||
				state?.status !== "queued"
			) {
				return { board: workspace.board, value: null, save: false };
			}
			const card = withAgentReview(location.card, { ...state, status: "reviewing", updatedAt: now() });
			return { board: replaceCard(workspace.board, card), value: card };
		});
		const card = marked.value;
		if (!card?.agentReview) {
			return null;
		}
		rememberCard(marked.state.board, card.id);
		await deps.broadcastStateUpdated();

		const config = await deps.loadRuntimeConfig();
		const { round, fixPrompts } = card.agentReview;
		const prepared: PreparedRun = {
			round,
			reviewerAgentId:
				config.reviewerAgent === "same_as_task" ? resolveTaskAgentId(card, config) : config.reviewerAgent,
			fingerprint: "",
			cwd: "",
			before: null,
			failure: null,
		};
		const taskId = card.id;
		let runLog = createReviewerLog(prepared.reviewerAgentId, round, now());
		reviewerLogs.set(taskId, runLog);
		// A cancelled run can still settle after the next run has started; leave that one alone.
		const updateLog = (update: (log: RuntimeAgentReviewLog) => RuntimeAgentReviewLog) => {
			if (reviewerLogs.get(taskId) === runLog) {
				runLog = update(runLog);
				reviewerLogs.set(taskId, runLog);
			}
		};
		try {
			prepared.cwd = await deps.resolveTaskCwd(card.id, card.baseRef);
			prepared.fingerprint = (
				await computeTaskReviewFingerprint({ cwd: prepared.cwd, baseRef: card.baseRef })
			).fingerprint;
			prepared.before = await captureWorktreeSnapshot(prepared.cwd);
		} catch (error) {
			prepared.failure = errorMessage(error);
			updateLog((log) => ({ ...appendReviewerLog(log, prepared.failure ?? ""), finishedAt: now() }));
			return prepared;
		}
		run.handle = runReviewer({
			agentId: prepared.reviewerAgentId,
			cwd: prepared.cwd,
			prompt: buildReviewerPrompt({
				title: card.title ?? "",
				prompt: card.prompt,
				baseRef: card.baseRef,
				round: round + 1,
				previousFixPrompts: fixPrompts,
			}),
			timeoutMs: REVIEWER_RUN_TIMEOUT_MS,
			isAgentInstalled,
			clineService: deps.clineService,
			reviewKey: `${AGENT_REVIEW_SESSION_KEY_PREFIX}${card.id}`,
			onOutput: (chunk) => updateLog((log) => appendReviewerLog(log, chunk)),
		});
		void run.handle.done.then((outcome) =>
			updateLog((log) => {
				// Cline runs do not stream; their final message is the output.
				const extra =
					outcome.kind === "completed" && log.output === ""
						? outcome.output
						: outcome.kind === "crashed"
							? `\n${outcome.error}`
							: outcome.kind === "unavailable"
								? outcome.reason
								: "";
				return { ...appendReviewerLog(log, extra), finishedAt: now() };
			}),
		);
		return prepared;
	}

	async function toReviewerOutcome(
		prepared: PreparedRun,
		runOutcome: ReviewerRunOutcome | null,
	): Promise<ReviewerOutcome | null> {
		if (prepared.failure !== null || !prepared.before || !runOutcome) {
			return { kind: "crashed", error: prepared.failure ?? "Reviewer did not start." };
		}
		if (runOutcome.kind === "cancelled") {
			return null;
		}
		try {
			const changedPaths = diffWorktreeSnapshots(prepared.before, await captureWorktreeSnapshot(prepared.cwd));
			if (changedPaths.length > 0) {
				return { kind: "modified_worktree", paths: changedPaths };
			}
		} catch (error) {
			if (error instanceof AgentReviewGitError) {
				return { kind: "crashed", error: error.message };
			}
			throw error;
		}
		switch (runOutcome.kind) {
			case "completed": {
				const parsed = parseReviewerOutput(runOutcome.output);
				return parsed.ok ? { kind: "result", result: parsed.result } : { kind: "bad_output", error: parsed.error };
			}
			case "timeout":
				return { kind: "timeout" };
			case "crashed":
				return { kind: "crashed", error: runOutcome.error };
			case "unavailable":
				return { kind: "unavailable", reason: runOutcome.reason };
		}
	}

	async function recoverAfterRestart(): Promise<void> {
		const { board } = await loadWorkspaceState(deps.repoPath);
		for (const column of board.columns) {
			for (const card of column.cards) {
				knownCards.set(card.id, { columnId: column.id, enabled: card.agentReviewEnabled === true });
			}
		}
		for (const column of board.columns) {
			for (const card of column.cards) {
				const status = card.agentReview?.status;
				if (card.agentReviewEnabled !== true || !status || status === "passed" || status === "no_changes") {
					continue;
				}
				const summary = deps.terminalManager.getSummary(card.id) ?? deps.clineService.getSummary(card.id);
				// One card failing (e.g. its commit relaunch) must not leave the cards after it unrecovered.
				try {
					await applyEvent(card.id, {
						type: "runtime_restarted",
						taskSessionRunning: summary?.state === "running",
						commitHash: status === "committing" ? await readCommitResult(card) : null,
					});
				} catch (error) {
					warn(`[agent-review] ${deps.workspaceId}: could not recover ${card.id}: ${errorMessage(error)}`);
				}
			}
		}
	}

	async function handleBoardChanged(): Promise<void> {
		const { board } = await loadWorkspaceState(deps.repoPath);
		const seen = new Set<string>();
		for (const column of board.columns) {
			for (const card of column.cards) {
				seen.add(card.id);
				const previous = knownCards.get(card.id);
				const enabled = card.agentReviewEnabled === true;
				knownCards.set(card.id, { columnId: column.id, enabled });
				if (previous?.enabled && !enabled) {
					await applyEvent(card.id, { type: "toggled_off" });
				} else if (enabled && previous && previous.columnId !== column.id) {
					await applyEvent(card.id, { type: "moved_by_user", to: column.id }, { columnId: previous.columnId });
				}
			}
		}
		for (const taskId of [...knownCards.keys()]) {
			if (!seen.has(taskId)) {
				knownCards.delete(taskId);
				clearCommitTimer(taskId);
				cancelReview(taskId);
				reviewerLogs.delete(taskId);
			}
		}
	}

	return {
		async start() {
			unsubscribes = [deps.terminalManager.onSummary(onSummary), deps.clineService.onSummary(onSummary)];
			await serialize(recoverAfterRestart);
		},
		notifyUserInput(taskId) {
			void serialize(() => applyEvent(taskId, { type: "user_input" }));
		},
		async notifyBoardChanged() {
			await serialize(handleBoardChanged);
		},
		getReviewerLog(taskId) {
			return reviewerLogs.get(taskId) ?? null;
		},
		async dispose() {
			disposed = true;
			for (const unsubscribe of unsubscribes) {
				unsubscribe();
			}
			unsubscribes = [];
			for (const taskId of [...commitTimers.keys()]) {
				clearCommitTimer(taskId);
			}
			for (const taskId of [...turnStartTimers.keys()]) {
				clearTurnStartTimer(taskId);
			}
			reviewQueue.length = 0;
			if (activeRun) {
				activeRun.cancelled = true;
				activeRun.handle?.cancel();
			}
			await chain;
		},
	};
}
