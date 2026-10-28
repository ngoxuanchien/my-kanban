import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
	type AgentReviewService,
	COMMIT_STEP_TIMEOUT_MS,
	createAgentReviewService,
} from "../../../src/agent-review/agent-review-service";
import { AGENT_REVIEW_RESULT_END, AGENT_REVIEW_RESULT_START } from "../../../src/agent-review/reviewer-output";
import type {
	ReviewerRunHandle,
	ReviewerRunOutcome,
	StartReviewerRunInput,
} from "../../../src/agent-review/reviewer-runner";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type {
	RuntimeAgentReviewResult,
	RuntimeAgentReviewState,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

type CardSpec = { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId };

function createCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Do ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		agentId: "cline",
		agentReviewEnabled: true,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(specs: CardSpec[]): RuntimeBoardData {
	const columns: RuntimeBoardData["columns"] = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "user_review", title: "Needs your review", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	return {
		columns: columns.map((column) => ({
			...column,
			cards: specs.filter((spec) => spec.columnId === column.id).map((spec) => spec.card),
		})),
		dependencies: [],
	};
}

function reviewState(overrides: Partial<RuntimeAgentReviewState> = {}): RuntimeAgentReviewState {
	return {
		status: "queued",
		round: 0,
		reason: null,
		reasonDetail: null,
		fingerprint: null,
		lastResult: null,
		fixPrompts: [],
		summary: null,
		meta: null,
		updatedAt: 1,
		...overrides,
	};
}

const SUMMARY = {
	whatWasDone: "Added the feature.",
	whatItAffects: "The feature screen.",
	againstRequest: "Nothing",
	howVerified: "npm test passed; app started.",
	risks: "None",
};

function reviewerOutput(result: Partial<RuntimeAgentReviewResult>): string {
	const full: RuntimeAgentReviewResult = {
		verdict: "pass",
		appVerified: true,
		appCheck: "npm start worked",
		tests: [{ command: "npm test", result: "3 passed" }],
		summary: SUMMARY,
		fixPrompt: null,
		notes: null,
		...result,
	};
	return `Reviewed.\n${AGENT_REVIEW_RESULT_START}\n${JSON.stringify(full)}\n${AGENT_REVIEW_RESULT_END}\n`;
}

const PASS_OUTPUT = reviewerOutput({});
const failOutput = (fixPrompt: string) => reviewerOutput({ verdict: "fail", summary: null, fixPrompt });
const CANNOT_VERIFY_OUTPUT = reviewerOutput({ verdict: "cannot_verify", appVerified: false, summary: null });

function summary(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "cline",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...patch,
	};
}

function hookActivity(hookEventName: string, finalMessage: string | null = null) {
	return {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage,
		hookEventName,
		notificationType: null,
		source: null,
	};
}

const turnEnd = (taskId: string, finalMessage: string | null = null) =>
	summary(taskId, {
		state: "awaiting_review",
		reviewReason: "hook",
		latestHookActivity: hookActivity("Stop", finalMessage),
	});
const running = (taskId: string) => summary(taskId, { state: "running" });
const permissionRequest = (taskId: string) =>
	summary(taskId, {
		state: "awaiting_review",
		reviewReason: "hook",
		latestHookActivity: hookActivity("PermissionRequest"),
	});

interface DeferredRun {
	resolve(outcome: ReviewerRunOutcome): void;
	cancel: Mock<() => void>;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

describe.sequential("AgentReviewService", () => {
	let repoPath = "";
	let cleanups: Array<() => void> = [];
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;
	let service: AgentReviewService | null = null;

	let summaryListeners: Array<(summary: RuntimeTaskSessionSummary) => void> = [];
	let liveSummaries: Map<string, RuntimeTaskSessionSummary>;
	let sentPrompts: Array<{ taskId: string; text: string }>;
	let reviewerInputs: StartReviewerRunInput[];
	let reviewerScripts: Array<(input: StartReviewerRunInput) => ReviewerRunHandle>;
	let doneCalls: string[];
	let broadcasts: number;
	let deletedCardAtWorktreeDelete: RuntimeBoardCard | null;

	beforeEach(() => {
		const home = createTempDir("kanban-home-");
		const sandbox = createTempDir("kanban-agent-review-");
		cleanups = [home.cleanup, sandbox.cleanup];
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		repoPath = join(sandbox.path, "project");
		mkdirSync(repoPath, { recursive: true });
		git(repoPath, ["init", "-b", "main"]);
		writeFileSync(join(repoPath, "README.md"), "hello\n");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-m", "init"]);

		summaryListeners = [];
		liveSummaries = new Map();
		sentPrompts = [];
		reviewerInputs = [];
		reviewerScripts = [];
		doneCalls = [];
		broadcasts = 0;
		deletedCardAtWorktreeDelete = null;
	});

	afterEach(async () => {
		vi.useRealTimers();
		await service?.dispose();
		service = null;
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		for (const cleanup of cleanups) {
			cleanup();
		}
	});

	function emit(next: RuntimeTaskSessionSummary): void {
		liveSummaries.set(next.taskId, next);
		for (const listener of summaryListeners) {
			listener(next);
		}
	}

	const fakeSessionService = {
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			summaryListeners.push(listener);
			return () => {
				summaryListeners = summaryListeners.filter((candidate) => candidate !== listener);
			};
		},
		getSummary: (taskId: string) => liveSummaries.get(taskId) ?? null,
		sendTaskSessionInput: async (taskId: string, text: string) => {
			sentPrompts.push({ taskId, text });
			return summary(taskId, {});
		},
		rebindPersistedTaskSession: async () => null,
		writeInput: () => null,
	};

	const config = {
		selectedAgentId: "cline",
		reviewerAgent: "same_as_task",
		commitPromptTemplate: "Commit the work on top of {{base_ref}}.",
		openPrPromptTemplate: "Open a PR against {{base_ref}}.",
		commitPromptTemplateDefault: "",
		openPrPromptTemplateDefault: "",
	} as unknown as RuntimeConfigState;

	async function startService(specs: CardSpec[]): Promise<void> {
		await saveWorkspaceState(repoPath, { board: createBoard(specs), sessions: {} });
		service = createAgentReviewService({
			workspaceId: "workspace-1",
			repoPath,
			// The service only uses onSummary/getSummary/writeInput and the Cline send/rebind calls.
			terminalManager: { onSummary: () => () => {}, getSummary: () => null } as unknown as TerminalSessionManager,
			clineService: fakeSessionService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => config,
			resolveTaskCwd: async () => repoPath,
			doneDeps: {
				notifyStateUpdated: async () => {
					doneCalls.push("notify");
				},
				stopTaskSession: async () => {
					doneCalls.push("stop");
				},
				startTask: async (taskId) => {
					doneCalls.push(`start:${taskId}`);
				},
				deleteTaskWorktree: async (taskId) => {
					doneCalls.push("delete");
					deletedCardAtWorktreeDelete = await findCard(taskId, "trash");
					return { removed: true };
				},
			},
			broadcastStateUpdated: async () => {
				broadcasts += 1;
			},
			startReviewerRun: (input) => {
				reviewerInputs.push(input);
				const script = reviewerScripts.shift();
				if (!script) {
					throw new Error("Unexpected reviewer run");
				}
				return script(input);
			},
		});
		await service.start();
	}

	function scriptOutcome(outcome: ReviewerRunOutcome, beforeDone?: (input: StartReviewerRunInput) => void): void {
		reviewerScripts.push((input) => {
			beforeDone?.(input);
			return { done: Promise.resolve(outcome), cancel: vi.fn() };
		});
	}

	function scriptDeferred(): DeferredRun {
		let resolveDone: (outcome: ReviewerRunOutcome) => void = () => {};
		const done = new Promise<ReviewerRunOutcome>((resolve) => {
			resolveDone = resolve;
		});
		const run: DeferredRun = { resolve: (outcome) => resolveDone(outcome), cancel: vi.fn() };
		reviewerScripts.push(() => ({ done, cancel: run.cancel }));
		return run;
	}

	async function findCard(taskId: string, columnId?: RuntimeBoardColumnId): Promise<RuntimeBoardCard | null> {
		const state = await loadWorkspaceState(repoPath);
		for (const column of state.board.columns) {
			if (columnId && column.id !== columnId) {
				continue;
			}
			const card = column.cards.find((candidate) => candidate.id === taskId);
			if (card) {
				return card;
			}
		}
		return null;
	}

	async function columnOf(taskId: string): Promise<RuntimeBoardColumnId | null> {
		const state = await loadWorkspaceState(repoPath);
		return state.board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;
	}

	async function waitForReview(taskId: string, match: Partial<RuntimeAgentReviewState>): Promise<void> {
		await vi.waitFor(
			async () => {
				expect((await findCard(taskId))?.agentReview).toMatchObject(match);
			},
			{ timeout: 5000, interval: 25 },
		);
	}

	async function waitForColumn(taskId: string, columnId: RuntimeBoardColumnId): Promise<void> {
		await vi.waitFor(async () => expect(await columnOf(taskId)).toBe(columnId), { timeout: 5000, interval: 25 });
	}

	function addChange(): void {
		writeFileSync(join(repoPath, "feature.txt"), "feature\n");
	}

	async function saveBoardAsBrowser(update: (board: RuntimeBoardData) => RuntimeBoardData): Promise<void> {
		const state = await loadWorkspaceState(repoPath);
		await saveWorkspaceState(repoPath, {
			board: update(state.board),
			sessions: state.sessions,
			expectedRevision: state.revision,
		});
		await service?.notifyBoardChanged();
	}

	it("reviews on turn end, passes, commits and completes to Done with meta saved before the worktree is deleted", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		scriptOutcome({ kind: "completed", output: PASS_OUTPUT });

		emit(turnEnd("A"));
		await waitForReview("A", { status: "committing" });
		expect(sentPrompts).toEqual([{ taskId: "A", text: "Commit the work on top of main." }]);
		expect(reviewerInputs[0]).toMatchObject({ agentId: "cline", cwd: repoPath, reviewKey: "agent-review:A" });

		emit(running("A"));
		await waitForColumn("A", "in_progress");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-m", "feature"]);
		const head = git(repoPath, ["rev-parse", "HEAD"]);
		emit(turnEnd("A", "Done. https://github.com/acme/app/pull/12"));

		await waitForColumn("A", "trash");
		await vi.waitFor(() => expect(doneCalls).toEqual(["notify", "stop", "delete"]), { timeout: 5000 });
		const card = await findCard("A", "trash");
		expect(card?.agentReview?.summary).toEqual(SUMMARY);
		expect(card?.agentReview?.meta).toMatchObject({
			commitHash: head,
			prUrl: "https://github.com/acme/app/pull/12",
			rounds: 0,
			reviewerAgentId: "cline",
		});
		expect(deletedCardAtWorktreeDelete?.agentReview?.meta?.commitHash).toBe(head);
	});

	it("moves in_progress → review on turn end without a browser", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		scriptDeferred();

		emit(turnEnd("A"));
		await waitForColumn("A", "review");
		await waitForReview("A", { status: "reviewing" });
		expect(broadcasts).toBeGreaterThan(0);
	});

	it("sends a fix prompt on fail and moves the card to in_progress when the agent runs", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		scriptOutcome({ kind: "completed", output: failOutput("1. Fix the button.") });

		emit(turnEnd("A"));
		await waitForReview("A", { status: "fixing", round: 1, fixPrompts: ["1. Fix the button."] });
		expect(sentPrompts).toHaveLength(1);
		expect(sentPrompts[0]?.text.startsWith("[Kanban agent review — fix round 1/3]")).toBe(true);
		expect(sentPrompts[0]?.text).toContain("1. Fix the button.");

		emit(running("A"));
		await waitForColumn("A", "in_progress");
	});

	it("fourth failed review moves to user_review with round_limit", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		for (let round = 1; round <= 4; round += 1) {
			scriptOutcome({ kind: "completed", output: failOutput(`fix ${round}`) });
		}

		for (let round = 1; round <= 3; round += 1) {
			emit(turnEnd("A"));
			await waitForReview("A", { status: "fixing", round });
			emit(running("A"));
			await waitForColumn("A", "in_progress");
		}
		emit(turnEnd("A"));

		await waitForReview("A", { status: "needs_user", reason: "round_limit", round: 3 });
		await waitForColumn("A", "user_review");
		expect(sentPrompts).toHaveLength(3);
		expect(reviewerInputs).toHaveLength(4);
	});

	it("empty diff sets no_changes and never runs the reviewer", async () => {
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);

		emit(turnEnd("A"));
		await waitForReview("A", { status: "no_changes", round: 0 });
		expect(await columnOf("A")).toBe("review");
		await settle();
		expect(reviewerInputs).toHaveLength(0);
	});

	it("permission request does not start a review", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		const before = await loadWorkspaceState(repoPath);

		emit(permissionRequest("A"));
		await settle();

		expect(reviewerInputs).toHaveLength(0);
		expect((await loadWorkspaceState(repoPath)).revision).toBe(before.revision);
		expect(await columnOf("A")).toBe("in_progress");
	});

	it("runs at most one reviewer at a time in a workspace", async () => {
		addChange();
		await startService([
			{ card: createCard("A"), columnId: "in_progress" },
			{ card: createCard("B"), columnId: "in_progress" },
		]);
		const first = scriptDeferred();
		scriptOutcome({ kind: "completed", output: CANNOT_VERIFY_OUTPUT });

		emit(turnEnd("A"));
		emit(turnEnd("B"));
		await waitForReview("B", { status: "queued" });
		await settle();
		expect(reviewerInputs.map((input) => input.reviewKey)).toEqual(["agent-review:A"]);

		first.resolve({ kind: "completed", output: CANNOT_VERIFY_OUTPUT });
		await waitForReview("B", { status: "needs_user", reason: "cannot_verify" });
		expect(reviewerInputs.map((input) => input.reviewKey)).toEqual(["agent-review:A", "agent-review:B"]);
		await waitForReview("A", { status: "needs_user", reason: "cannot_verify" });
	});

	it("reviewer that edits a tracked file sends the task to user_review with the path", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		scriptOutcome({ kind: "completed", output: PASS_OUTPUT }, (input) => {
			writeFileSync(join(input.cwd, "README.md"), "rewritten\n");
		});

		emit(turnEnd("A"));
		await waitForReview("A", {
			status: "needs_user",
			reason: "reviewer_modified_worktree",
			reasonDetail: "README.md",
		});
		await waitForColumn("A", "user_review");
		expect(sentPrompts).toHaveLength(0);
	});

	describe("drops reviewer result when the card left review mid-run", () => {
		it("card moved to trash", async () => {
			addChange();
			await startService([{ card: createCard("A"), columnId: "in_progress" }]);
			const run = scriptDeferred();
			emit(turnEnd("A"));
			await waitForReview("A", { status: "reviewing" });

			await saveBoardAsBrowser((board) => {
				const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === "A");
				return createBoard(card ? [{ card, columnId: "trash" }] : []);
			});
			await vi.waitFor(() => expect(run.cancel).toHaveBeenCalled(), { timeout: 5000 });
			const afterMove = await loadWorkspaceState(repoPath);

			run.resolve({ kind: "completed", output: PASS_OUTPUT });
			await settle();
			const final = await loadWorkspaceState(repoPath);
			expect(final.revision).toBe(afterMove.revision);
			expect(await columnOf("A")).toBe("trash");
			expect(sentPrompts).toHaveLength(0);
		});

		it("card deleted", async () => {
			addChange();
			await startService([{ card: createCard("A"), columnId: "in_progress" }]);
			const run = scriptDeferred();
			emit(turnEnd("A"));
			await waitForReview("A", { status: "reviewing" });

			await saveBoardAsBrowser(() => createBoard([]));
			await vi.waitFor(() => expect(run.cancel).toHaveBeenCalled(), { timeout: 5000 });
			const afterDelete = await loadWorkspaceState(repoPath);

			run.resolve({ kind: "completed", output: PASS_OUTPUT });
			await settle();
			expect((await loadWorkspaceState(repoPath)).revision).toBe(afterDelete.revision);
			expect(await columnOf("A")).toBeNull();
		});
	});

	it("user input during a review cancels it and resets the round", async () => {
		addChange();
		// The task agent is still running its fix turn, so startup recovery leaves the card alone.
		liveSummaries.set("A", running("A"));
		await startService([
			{
				card: createCard("A", { agentReview: reviewState({ status: "fixing", round: 2, fixPrompts: ["a", "b"] }) }),
				columnId: "in_progress",
			},
		]);
		const run = scriptDeferred();
		emit(turnEnd("A"));
		await waitForReview("A", { status: "reviewing", round: 2 });

		service?.notifyUserInput("A");
		await vi.waitFor(() => expect(run.cancel).toHaveBeenCalled(), { timeout: 5000 });
		await waitForReview("A", { round: 0, fixPrompts: [] });

		run.resolve({ kind: "completed", output: failOutput("stale") });
		await settle();
		expect(sentPrompts).toHaveLength(0);
	});

	it("toggle off during a review cancels it and clears state", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		const run = scriptDeferred();
		emit(turnEnd("A"));
		await waitForReview("A", { status: "reviewing" });

		await saveBoardAsBrowser((board) => ({
			...board,
			columns: board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => (card.id === "A" ? { ...card, agentReviewEnabled: false } : card)),
			})),
		}));
		await vi.waitFor(() => expect(run.cancel).toHaveBeenCalled(), { timeout: 5000 });
		await vi.waitFor(async () => expect((await findCard("A"))?.agentReview).toBeUndefined(), { timeout: 5000 });
		expect(await columnOf("A")).toBe("review");
	});

	it("diff failure goes to user_review instead of crashing the loop", async () => {
		addChange();
		await startService([
			{ card: createCard("A", { baseRef: "missing-branch" }), columnId: "in_progress" },
			{ card: createCard("B"), columnId: "in_progress" },
		]);
		scriptOutcome({ kind: "completed", output: CANNOT_VERIFY_OUTPUT });

		emit(turnEnd("A"));
		emit(turnEnd("B"));

		await waitForReview("A", { status: "needs_user", reason: "reviewer_crashed" });
		expect((await findCard("A"))?.agentReview?.reasonDetail).toBeTruthy();
		await waitForColumn("A", "user_review");
		await waitForReview("B", { status: "needs_user", reason: "cannot_verify" });
		expect(reviewerInputs.map((input) => input.reviewKey)).toEqual(["agent-review:B"]);
	});

	it("commit step timeout → commit_failed", async () => {
		addChange();
		await startService([{ card: createCard("A"), columnId: "in_progress" }]);
		scriptOutcome({ kind: "completed", output: PASS_OUTPUT });
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		emit(turnEnd("A"));
		await waitForReview("A", { status: "committing" });
		await vi.waitFor(() => expect(sentPrompts).toHaveLength(1), { timeout: 5000 });

		await vi.advanceTimersByTimeAsync(COMMIT_STEP_TIMEOUT_MS);
		await waitForReview("A", { status: "needs_user", reason: "commit_failed", summary: SUMMARY });
		await waitForColumn("A", "user_review");
	});

	it("restart recovery re-runs a review that was reviewing, same round", async () => {
		addChange();
		scriptOutcome({ kind: "completed", output: failOutput("fix 3") });
		await startService([
			{
				card: createCard("A", {
					agentReview: reviewState({ status: "reviewing", round: 2, fixPrompts: ["a", "b"] }),
				}),
				columnId: "review",
			},
		]);

		await waitForReview("A", { status: "fixing", round: 3, fixPrompts: ["a", "b", "fix 3"] });
		expect(reviewerInputs[0]?.prompt).toContain("Review round: 3");
		expect(reviewerInputs[0]?.prompt).toContain("1. a\n2. b");
		expect(sentPrompts[0]?.text.startsWith("[Kanban agent review — fix round 3/3]")).toBe(true);
	});

	it("tasks without agentReviewEnabled are never touched", async () => {
		addChange();
		await startService([
			{ card: createCard("A", { agentReviewEnabled: false }), columnId: "in_progress" },
			{ card: createCard("B", { agentReviewEnabled: undefined }), columnId: "review" },
		]);
		const before = await loadWorkspaceState(repoPath);

		emit(turnEnd("A"));
		emit(running("B"));
		service?.notifyUserInput("A");
		await service?.notifyBoardChanged();
		await settle();

		expect(reviewerInputs).toHaveLength(0);
		expect(sentPrompts).toHaveLength(0);
		expect(broadcasts).toBe(0);
		expect((await loadWorkspaceState(repoPath)).revision).toBe(before.revision);
	});
});
