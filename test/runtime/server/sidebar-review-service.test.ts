import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeBoardCard, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { AntigravityLog } from "../../../src/server/antigravity-log-usage-limit";
import { handOffTask as handOffTaskInWorkspace } from "../../../src/server/hand-off-task";
import { detectUsageLimit } from "../../../src/server/usage-limit-detector";
import type { SendPromptToSessionResult } from "../../../src/terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const workspaceState = vi.hoisted(() => ({
	board: {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Task one",
						prompt: "Do it",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 0,
						updatedAt: 0,
						agentReviewEnabled: true,
						agentId: undefined,
						reviewRound: 0,
						handedOff: false,
					},
					{
						id: "task-2",
						title: "Task two",
						prompt: "Do it",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 0,
						updatedAt: 0,
						agentReviewEnabled: true,
						agentId: undefined,
						reviewRound: 0,
						handedOff: false,
					},
				] as RuntimeBoardCard[],
			},
		],
	},
}));

const sendPromptToSession = vi.hoisted(() =>
	vi.fn(
		async (_input: { prompt: string; sessionId: string; agentId: string }): Promise<SendPromptToSessionResult> => ({
			ok: true,
		}),
	),
);
const runGit = vi.hoisted(() => vi.fn());
const handOffTask = vi.hoisted(() =>
	vi.fn(
		async (
			_taskId: string,
			_reason: string,
			_expectedFromAgentId?: "codex" | "opencode" | "antigravity",
		): Promise<{ ok: boolean; error?: string | null; fromAgentId?: string; toAgentId?: string }> => ({
			ok: true,
		}),
	),
);
const retryQuotaBlockedTask = vi.hoisted(() =>
	vi.fn(
		async (): Promise<{ ok: boolean; error?: string | null; toAgentId?: string }> => ({
			ok: true,
			toAgentId: "codex",
		}),
	),
);
const recordAgentScoreEvent = vi.hoisted(() => vi.fn(async () => true));
const recordTaskHistoryEvent = vi.hoisted(() =>
	vi.fn(async (_workspaceId: string, _taskId: string, _event: unknown) => true),
);

vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceState: vi.fn(async () => ({ board: workspaceState.board })),
	mutateWorkspaceState: vi.fn(
		async (
			_path: string,
			mutate: (state: { board: typeof workspaceState.board }) => {
				board: typeof workspaceState.board;
				value: unknown;
				save?: boolean;
			},
		) => {
			const result = mutate({ board: workspaceState.board });
			if (result.save !== false) workspaceState.board = result.board;
			return { saved: result.save !== false, value: result.value };
		},
	),
}));

vi.mock("../../../src/terminal/send-prompt-to-session", () => ({ sendPromptToSession }));
vi.mock("../../../src/state/agent-scores", () => ({ recordAgentScoreEvent }));
vi.mock("../../../src/state/task-history", () => ({ recordTaskHistoryEvent }));
vi.mock("../../../src/workspace/task-worktree", () => ({
	getTaskWorkspacePathInfo: vi.fn(async () => ({ path: "/worktree/task-1" })),
}));
vi.mock("../../../src/workspace/git-utils", () => ({ runGit }));

import { createSidebarReviewService } from "../../../src/server/sidebar-review-service";

async function startUsageLimitTurn(options: {
	agentId: "claude" | "codex" | "opencode" | "antigravity";
	handedOff?: boolean;
	handOffCount?: number;
	getRestoreSnapshot?: () => Promise<{ snapshot: string; cols: number; rows: number } | null>;
	now?: () => number;
	quotaBlockedAt?: number;
	reviewRound?: number;
	columnId?: string;
	reviewEnabled?: boolean;
	sidebarIdle?: boolean;
	setInterval?: typeof setInterval;
	clearInterval?: typeof clearInterval;
	readOpenCodeLog?: () => Promise<string | null>;
	readAntigravityLogs?: () => Promise<AntigravityLog[]>;
	readCodexModelError?: () => Promise<"model_not_found" | null>;
	session?: RuntimeTaskSessionSummary;
}) {
	const card = workspaceState.board.columns[0].cards[0];
	card.agentId = options.agentId;
	card.handedOff = options.handedOff ?? false;
	card.handOffCount = options.handOffCount ?? (options.handedOff === true ? 1 : 0);
	card.reviewRound = options.reviewRound ?? 0;
	card.agentReviewEnabled = options.reviewEnabled ?? true;
	if (options.quotaBlockedAt === undefined) delete card.quotaBlockedAt;
	else card.quotaBlockedAt = options.quotaBlockedAt;
	workspaceState.board.columns[0].id = options.columnId ?? "review";
	const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
	let sessionSummary = options.session ?? summary("task-1", "running");
	let intervalCallback: (() => void) | undefined;
	const writeInput = vi.fn((_taskId: string, _data: Buffer) => sessionSummary);
	const broadcastStateUpdated = vi.fn();
	const warn = vi.fn();
	const service = createSidebarReviewService({
		workspaceId: "workspace-1",
		workspacePath: "/repo",
		terminalManager: {
			listSummaries: () => [
				sessionSummary,
				...(options.sidebarIdle ? [summary("__home_agent__:workspace-1:claude", "awaiting_review")] : []),
			],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getRestoreSnapshot: options.getRestoreSnapshot ?? (async () => null),
			writeInput,
		} as unknown as TerminalSessionManager,
		clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
		loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
		broadcastStateUpdated,
		warn,
		handOffTask,
		retryQuotaBlockedTask,
		readOpenCodeLog: options.readOpenCodeLog ?? (async () => null),
		readAntigravityLogs: options.readAntigravityLogs ?? (async () => []),
		readCodexModelError: options.readCodexModelError,
		now: options.now,
		setInterval: (callback: Parameters<typeof setInterval>[0], delay: Parameters<typeof setInterval>[1]) => {
			intervalCallback = callback as () => void;
			return options.setInterval?.(callback, delay) ?? (1 as unknown as ReturnType<typeof setInterval>);
		},
		clearInterval: options.clearInterval,
	});
	await service.start();
	return {
		card,
		listeners,
		broadcastStateUpdated,
		warn,
		service,
		writeInput,
		setSessionSummary: (value: RuntimeTaskSessionSummary) => {
			sessionSummary = value;
		},
		runInterval: () => {
			intervalCallback?.();
		},
		setIntervalCallback: (callback: () => void) => {
			intervalCallback = callback;
		},
	};
}

function summary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		mode: null,
		agentId: "claude",
		workspacePath: "/repo",
		pid: 123,
		startedAt: 0,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("createSidebarReviewService", () => {
	beforeEach(() => {
		workspaceState.board.columns[0].id = "review";
		workspaceState.board.columns[0].cards[0].reviewRound = 0;
		delete workspaceState.board.columns[0].cards[0].quotaBlockedAt;
		workspaceState.board.columns[0].cards[1].reviewRound = 0;
		delete workspaceState.board.columns[0].cards[1].quotaBlockedAt;
		delete workspaceState.board.columns[0].cards[0].blockedReport;
		delete workspaceState.board.columns[0].cards[1].blockedReport;
		delete workspaceState.board.columns[0].cards[0].waitingReport;
		delete workspaceState.board.columns[0].cards[1].waitingReport;
		workspaceState.board.columns[0].cards[0].handedOff = false;
		workspaceState.board.columns[0].cards[1].handedOff = false;
		workspaceState.board.columns[0].cards[0].handOffCount = 0;
		workspaceState.board.columns[0].cards[1].handOffCount = 0;
		workspaceState.board.columns[0].cards[0].agentReviewEnabled = true;
		workspaceState.board.columns[0].cards[0].agentId = undefined;
		workspaceState.board.columns[0].cards[1].agentReviewEnabled = true;
		workspaceState.board.columns[0].cards[1].agentId = undefined;
		sendPromptToSession.mockClear();
		recordAgentScoreEvent.mockClear();
		recordTaskHistoryEvent.mockClear();
		handOffTask.mockReset();
		handOffTask.mockResolvedValue({ ok: true, fromAgentId: "codex", toAgentId: "opencode" });
		retryQuotaBlockedTask.mockReset();
		retryQuotaBlockedTask.mockResolvedValue({ ok: true, toAgentId: "codex" });
		runGit.mockReset();
		runGit.mockResolvedValueOnce({ ok: true, stdout: " M file" }).mockResolvedValueOnce({ ok: true, stdout: "0" });
	});

	it("hands off a failed Codex task without queueing a review", async () => {
		const card = workspaceState.board.columns[0].cards[0];
		card.agentId = "codex";
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners) listener({ ...summary("task-1", "failed"), agentId: "codex", exitCode: 7 });
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith(
				"task-1",
				"The previous agent stopped with an error (exit code 7).",
				"codex",
			),
		);
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "handoff",
			agentId: "codex",
			toAgentId: "opencode",
			round: 0,
			detail: "The previous agent stopped with an error (exit code 7).",
		});
		expect(recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(card.reviewRound).toBe(0);
		service.dispose();
	});

	it("uses unknown for a failed task with no exit code", async () => {
		workspaceState.board.columns[0].cards[0].agentId = "codex";
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners) listener({ ...summary("task-1", "failed"), agentId: "codex" });
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith(
				"task-1",
				"The previous agent stopped with an error (exit code unknown).",
				"codex",
			),
		);
		service.dispose();
	});

	it("hands off an antigravity crash before the limit", async () => {
		workspaceState.board.columns[0].cards[0].agentId = "antigravity";
		workspaceState.board.columns[0].cards[0].handOffCount = 0;
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners)
			listener({ ...summary("task-1", "failed"), agentId: "antigravity", exitCode: 1 });
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith(
				"task-1",
				"The previous agent stopped with an error (exit code 1).",
				"antigravity",
			),
		);
		service.dispose();
	});

	it("refuses a crash handoff when a usage handoff changes the card after the crash check", async () => {
		const card = workspaceState.board.columns[0].cards[0];
		card.agentId = "opencode";
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const stopTaskSession = vi.fn(async () => {});
		const startTaskSession = vi.fn(async () => ({ ok: true }));
		handOffTask.mockImplementationOnce(async (taskId, reason, expectedFromAgentId) => {
			// Simulate the usage-limit handoff winning after the crash handler read the old card.
			card.agentId = "antigravity";
			card.handOffCount = 1;
			await recordTaskHistoryEvent("workspace-1", taskId, {
				type: "handoff",
				agentId: "opencode",
				toAgentId: "antigravity",
				round: 0,
				detail: "The previous agent hit its usage limit.",
			});
			return handOffTaskInWorkspace(
				{
					workspacePath: "/repo",
					stopTaskSession,
					startTaskSession,
					broadcastStateUpdated: vi.fn(),
				},
				{ taskId, reason, expectedFromAgentId },
			);
		});
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [{ ...summary("task-1", "running"), agentId: "opencode", startedAt: 100 }],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners)
			listener({ ...summary("task-1", "failed"), agentId: "opencode", startedAt: 100, exitCode: 1 });
		await vi.waitFor(() => expect(handOffTask).toHaveBeenCalledTimes(1));

		expect(card).toMatchObject({ agentId: "antigravity", handOffCount: 1 });
		expect(recordTaskHistoryEvent).toHaveBeenCalledTimes(1);
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			expect.objectContaining({ type: "handoff", agentId: "opencode", toAgentId: "antigravity" }),
		);
		expect(stopTaskSession).not.toHaveBeenCalled();
		expect(startTaskSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("ignores a stopped OpenCode session crashing after handoff to Antigravity", async () => {
		const { listeners, service } = await startUsageLimitTurn({
			agentId: "antigravity",
			handOffCount: 1,
			reviewRound: 4,
			columnId: "in_progress",
			session: { ...summary("task-1", "running"), agentId: "opencode" },
		});

		for (const listener of listeners) {
			listener({ ...summary("task-1", "failed"), agentId: "opencode", exitCode: 1 });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(handOffTask).not.toHaveBeenCalled();
		service.dispose();
	});

	it("does not hand off an antigravity crash after two handoffs", async () => {
		workspaceState.board.columns[0].cards[0].agentId = "antigravity";
		workspaceState.board.columns[0].cards[0].handOffCount = 2;
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners)
			listener({ ...summary("task-1", "failed"), agentId: "antigravity", exitCode: 1 });
		await vi.waitFor(() => expect(handOffTask).not.toHaveBeenCalled());
		service.dispose();
	});

	it("keeps a successful exit on the normal review path", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners)
			listener({ ...summary("task-1", "awaiting_review"), reviewReason: "exit", exitCode: 0 });
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(handOffTask).not.toHaveBeenCalled();
		service.dispose();
	});

	it("does not hand off when review is disabled", async () => {
		workspaceState.board.columns[0].cards[0].agentReviewEnabled = false;
		workspaceState.board.columns[0].cards[0].agentId = "codex";
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "running")],
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners) listener({ ...summary("task-1", "failed"), agentId: "codex", exitCode: 1 });
		await vi.waitFor(() => expect(handOffTask).not.toHaveBeenCalled());
		service.dispose();
	});

	it("restores reviews through round 9", async () => {
		const card = workspaceState.board.columns[0].cards[0];
		card.handOffCount = 2;
		card.reviewRound = 8;
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("__home_agent__:workspace-1:claude", "awaiting_review")],
				onSummary: () => () => {},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});

		await service.start();
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: '[Kanban review] Task task-1 "Task one" is in Review, round 8/9. Review it now.',
			}),
		);
		service.dispose();
	});

	it("resets handOffCount when review is turned off", async () => {
		const card = workspaceState.board.columns[0].cards[0];
		card.agentReviewEnabled = false;
		card.handOffCount = 1;
		card.reviewRound = 4;
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: { listSummaries: () => [], onSummary: () => () => {} } as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});

		await service.notifyBoardChanged();
		expect(workspaceState.board.columns[0].cards[0].handOffCount).toBe(0);
		expect(workspaceState.board.columns[0].cards[0]).not.toHaveProperty("handedOff");
		expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(0);
		service.dispose();
	});

	it("starts one review when review is enabled for a finished task", async () => {
		const broadcastStateUpdated = vi.fn();
		const summaries = [
			summary("task-1", "awaiting_review"),
			summary("__home_agent__:workspace-1:claude", "awaiting_review"),
		];
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => summaries,
				onSummary: () => () => {},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated,
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});

		await service.start();
		await service.notifyBoardChanged();
		await service.notifyBoardChanged();

		expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1);
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "__home_agent__:workspace-1:claude",
				prompt: '[Kanban review] Task task-1 "Task one" is in Review, round 1/3. Review it now.',
			}),
		);
		service.dispose();
	});

	it.each([
		{ name: "a card outside Review", columnId: "backlog", round: 0, session: true },
		{ name: "a card already reviewed", columnId: "review", round: 1, session: true },
		{ name: "a task without a session", columnId: "review", round: 0, session: false },
	])("does not start a review for $name", async ({ columnId, round, session: hasSession }) => {
		workspaceState.board.columns[0].id = columnId;
		workspaceState.board.columns[0].cards[0].reviewRound = round;
		const summaries = hasSession ? [summary("task-1", "awaiting_review")] : [];
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => summaries,
				onSummary: () => () => {},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});

		await service.start();
		await service.notifyBoardChanged();

		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it.each([
		{ name: "a changed worktree", status: " M file", expectReview: true },
		{ name: "an empty worktree", status: "", expectReview: false },
	])("deduplicates a turn end racing with a board save for $name", async ({ status, expectReview }) => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		let summaries = [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "awaiting_review")];
		let releaseStatus: ((result: { ok: boolean; stdout: string }) => void) | undefined;
		runGit
			.mockReset()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseStatus = resolve;
					}),
			)
			.mockResolvedValueOnce({ ok: true, stdout: "0" });
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => summaries,
				onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});

		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(runGit).toHaveBeenCalledTimes(1));
		summaries = [
			summary("task-1", "awaiting_review"),
			summary("__home_agent__:workspace-1:claude", "awaiting_review"),
		];
		const notification = service.notifyBoardChanged();
		releaseStatus?.({ ok: true, stdout: status });
		await notification;

		if (expectReview) {
			await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
			await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
			expect(sendPromptToSession).toHaveBeenCalledTimes(1);
			expect(sendPromptToSession.mock.calls[0]?.[0].sessionId).toBe("__home_agent__:workspace-1:claude");
		} else {
			await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
			expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(0);
			expect(sendPromptToSession.mock.calls[0]?.[0]).toMatchObject({
				sessionId: "task-1",
				prompt: expect.stringContaining("No changes found"),
			});
		}
		service.dispose();
	});

	it("warns once when both agents hit their usage limit across board notifications", async () => {
		let clock = 1_000_000;
		let tick: (() => void) | undefined;
		const card = workspaceState.board.columns[0].cards[0];
		card.agentId = "codex";
		card.handOffCount = 2;
		const warn = vi.fn();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: {
				listSummaries: () => [summary("task-1", "awaiting_review")],
				onSummary: () => () => {},
				getRestoreSnapshot: async () => ({ snapshot: "Free usage limit reached", cols: 80, rows: 24 }),
			} as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn,
			handOffTask,
			retryQuotaBlockedTask,
			now: () => clock,
			setInterval: (callback: () => void) => {
				tick = callback;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
		});

		await service.start();
		await service.notifyBoardChanged();
		await service.notifyBoardChanged();
		clock += 300000;
		tick?.();
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[sidebar-review] Task task-1: both agents hit their usage limit; leaving it in Review",
		);
		service.dispose();
	});

	it("waits for the running sidebar's turn to end before sending one review", async () => {
		const terminalListeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const clineListeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				terminalListeners.add(listener);
				return () => terminalListeners.delete(listener);
			},
		};
		const clineService = {
			listSummaries: () => [],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				clineListeners.add(listener);
				return () => clineListeners.delete(listener);
			},
		};
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();

		for (const listener of terminalListeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(sendPromptToSession).not.toHaveBeenCalled();

		for (const listener of terminalListeners)
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "__home_agent__:workspace-1:claude",
				prompt: '[Kanban review] Task task-1 "Task one" is in Review, round 1/3. Review it now.',
			}),
		);
		service.dispose();
	});

	it("sends simultaneous task reviews in separate sidebar idle periods", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [
				summary("task-1", "running"),
				summary("task-2", "running"),
				summary("__home_agent__:workspace-1:claude", "awaiting_review"),
			],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners) {
			listener(summary("task-1", "awaiting_review"));
			listener(summary("task-2", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);

		for (const listener of listeners) {
			listener(summary("__home_agent__:workspace-1:claude", "running"));
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(sendPromptToSession.mock.calls[0]?.[0].prompt).toContain("Task task-1");
		expect(sendPromptToSession.mock.calls[1]?.[0].prompt).toContain("Task task-2");
		service.dispose();
	});

	it("retries the same task after a failed send on the next sidebar idle", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [
				summary("task-1", "running"),
				summary("__home_agent__:workspace-1:claude", "awaiting_review"),
			],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		sendPromptToSession.mockResolvedValueOnce({ ok: false, reason: "session_not_running" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		const firstPrompt = sendPromptToSession.mock.calls[0]?.[0].prompt;

		for (const listener of listeners) {
			listener(summary("__home_agent__:workspace-1:claude", "running"));
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(sendPromptToSession.mock.calls[1]?.[0].prompt).toBe(firstPrompt);
		service.dispose();
	});

	it("uses the currently selected sidebar agent when delivering", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		let selectedAgentId: RuntimeConfigState["selectedAgentId"] = "claude";
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		selectedAgentId = "codex";
		for (const listener of listeners) listener(summary("__home_agent__:workspace-1:codex", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "__home_agent__:workspace-1:codex",
				agentId: "codex",
			}),
		);
		service.dispose();
	});

	it("hands off a task immediately when the screen shows a usage limit", async () => {
		const { card, listeners, broadcastStateUpdated, service } = await startUsageLimitTurn({
			agentId: "codex",
			getRestoreSnapshot: async () => ({ snapshot: "You’ve hit your usage limit", cols: 80, rows: 24 }),
		});
		const reviewSummary = { ...summary("task-1", "awaiting_review"), agentId: "codex" as const };
		for (const listener of listeners) listener(reviewSummary);
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith("task-1", "The previous agent hit its usage limit."),
		);
		expect(detectUsageLimit("The previous agent hit its usage limit.")).toBeNull();
		expect(recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "handoff",
			agentId: "codex",
			toAgentId: "opencode",
			round: 0,
			detail: 'The previous agent hit its usage limit ("hit your usage limit").',
		});
		expect(recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(card.reviewRound).toBe(0);
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(broadcastStateUpdated).not.toHaveBeenCalled();
		service.dispose();
	});

	it("hands off OpenCode immediately when the screen shows a quota message", async () => {
		const { card, listeners, service } = await startUsageLimitTurn({
			agentId: "opencode",
			getRestoreSnapshot: async () => ({
				snapshot: "AI.Error.QuotaExceeded: Free usage limit\nreached. Free models work in OpenCode",
				cols: 80,
				rows: 24,
			}),
		});
		const reviewSummary = summary("task-1", "awaiting_review");
		for (const listener of listeners) listener(reviewSummary);
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith("task-1", "The previous agent hit its usage limit."),
		);
		expect(card.reviewRound).toBe(0);
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("hands off immediately when only the OpenCode log has the quota message", async () => {
		const { listeners, service } = await startUsageLimitTurn({
			agentId: "opencode",
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
			readOpenCodeLog: async () =>
				'timestamp=2026-10-30T03:27:26.454Z level=INFO run=abc directory="/worktree/task-1"\ntimestamp=2026-10-30T03:27:31.247Z level=ERROR run=abc cause="AI.Error: Free usage limit reached"',
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith("task-1", "The previous agent hit its usage limit."),
		);
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("hands off Codex immediately for model_not_found without continuing", async () => {
		const { listeners, service } = await startUsageLimitTurn({
			agentId: "codex",
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
			readCodexModelError: async () => "model_not_found",
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith("task-1", "Codex cannot use its configured model (model_not_found)."),
		);
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith(
			"workspace-1",
			"task-1",
			expect.objectContaining({
				type: "comment",
				agentId: "codex",
				detail: 'Change "model" in ~/.codex/config.toml to one your account supports.',
			}),
		);
		service.dispose();
	});

	it("quota-blocks Codex with model_not_found when the handoff chain is exhausted", async () => {
		const { listeners, service } = await startUsageLimitTurn({
			agentId: "codex",
			handOffCount: 2,
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
			readCodexModelError: async () => "model_not_found",
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].quotaBlockedAt).toBeDefined());
		expect(handOffTask).not.toHaveBeenCalled();
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("continues normal review when the OpenCode log reader rejects", async () => {
		const { listeners, service, warn } = await startUsageLimitTurn({
			agentId: "opencode",
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
			readOpenCodeLog: async () => {
				throw new Error("log unavailable");
			},
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(warn).toHaveBeenCalledWith("[sidebar-review] Could not read OpenCode log for task-1: log unavailable");
		expect(handOffTask).not.toHaveBeenCalled();
		service.dispose();
	});

	it("leaves a handed-off task in Review when the other agent also hits its usage limit", async () => {
		const clock = 1_000_000;
		const { card, listeners, broadcastStateUpdated, warn, service } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			getRestoreSnapshot: async () => ({ snapshot: "Free usage limit reached", cols: 80, rows: 24 }),
			now: () => clock,
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() =>
			expect(warn).toHaveBeenCalledWith(
				"[sidebar-review] Task task-1: both agents hit their usage limit; leaving it in Review",
			),
		);
		expect(handOffTask).not.toHaveBeenCalled();
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(broadcastStateUpdated).toHaveBeenCalledTimes(1);
		expect(workspaceState.board.columns[0].cards[0].quotaBlockedAt).toBe(clock);
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "quota_blocked",
			agentId: "opencode",
			round: 0,
		});
		expect(recordTaskHistoryEvent).toHaveBeenCalledTimes(1);
		expect(recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(retryQuotaBlockedTask).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(card.reviewRound).toBe(0);
		service.dispose();
	});

	it("nudges a running task silent for five minutes only once in its turn", async () => {
		const clock = 1_000_000;
		const { service, runInterval } = await startUsageLimitTurn({ agentId: "codex", now: () => clock });
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "continue", sessionId: "task-1" }),
		);
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(handOffTask).not.toHaveBeenCalled();
		expect(recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "retry",
			agentId: "codex",
			round: 0,
			detail: "continue sent (usage limit or no output for 5 min)",
		});
		expect(recordAgentScoreEvent).not.toHaveBeenCalled();
		service.dispose();
	});

	it("does not nudge or hand off a running task waiting for approval", async () => {
		let clock = 1_000_000;
		const getRestoreSnapshot = vi.fn(async () => null);
		const { service, runInterval, card } = await startUsageLimitTurn({
			agentId: "codex",
			columnId: "in_progress",
			now: () => clock,
			getRestoreSnapshot,
			session: {
				...summary("task-1", "running"),
				agentId: "codex",
				lastOutputAt: clock - 300001,
				latestHookActivity: {
					activityText: "Waiting for approval",
					hookEventName: "PermissionRequest",
					notificationType: "permission_prompt",
					toolName: "Bash",
					toolInputSummary: null,
					finalMessage: null,
					source: "codex",
				},
			},
		});
		try {
			runInterval();
			await new Promise<void>((resolve) => setImmediate(resolve));
			clock += 600000;
			runInterval();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(getRestoreSnapshot).toHaveBeenCalledTimes(2);
			expect(sendPromptToSession).not.toHaveBeenCalled();
			expect(handOffTask).not.toHaveBeenCalled();
			expect(card.reviewRound).toBe(0);
			expect(recordTaskHistoryEvent).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	});

	it("still nudges a silent running task after the approval is answered", async () => {
		const clock = 1_000_000;
		const { service, runInterval } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			session: {
				...summary("task-1", "running"),
				lastOutputAt: clock - 300001,
				latestHookActivity: {
					activityText: "Completed Bash",
					hookEventName: "PostToolUse",
					notificationType: "permission_prompt",
					toolName: "Bash",
					toolInputSummary: null,
					finalMessage: null,
					source: "codex",
				},
			},
		});
		try {
			runInterval();
			await vi.waitFor(() =>
				expect(sendPromptToSession).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ prompt: "continue", sessionId: "task-1" }),
				),
			);
		} finally {
			service.dispose();
		}
	});

	it("does not nudge a running task that produced output within five minutes", async () => {
		const clock = 1_000_000;
		const { service, runInterval } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			session: { ...summary("task-1", "running"), lastOutputAt: clock - 1000 },
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).not.toHaveBeenCalled());
		expect(recordTaskHistoryEvent).not.toHaveBeenCalled();
		service.dispose();
	});

	it("does not hand off after output arrives following a nudge", async () => {
		let clock = 1_000_000;
		const { service, runInterval, setSessionSummary } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			getRestoreSnapshot: async () => null,
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		setSessionSummary({ ...summary("task-1", "running"), lastOutputAt: clock + 1 }); // PTY echo from continue.
		clock += 120000;
		setSessionSummary({ ...summary("task-1", "running"), lastOutputAt: clock });
		clock += 300000;
		runInterval();
		await vi.waitFor(() => expect(handOffTask).not.toHaveBeenCalled());
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);
		service.dispose();
	});

	it("hands off when only the continue echo arrives and the task stays silent", async () => {
		let clock = 1_000_000;
		const { service, runInterval, setSessionSummary } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			getRestoreSnapshot: async () => null,
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		setSessionSummary({ ...summary("task-1", "running"), lastOutputAt: clock + 1 });
		clock += 300001;
		runInterval();
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith(
				"task-1",
				"The previous agent produced no terminal output for 5 minutes after continue.",
			),
		);
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);
		service.dispose();
	});

	it("keeps one nudge for a stuck Claude task outside the handoff chain", async () => {
		let clock = 1_000_000;
		const { service, runInterval, setSessionSummary, warn } = await startUsageLimitTurn({
			agentId: "claude",
			now: () => clock,
			getRestoreSnapshot: async () => null,
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		setSessionSummary({ ...summary("task-1", "running"), lastOutputAt: clock + 1 });
		clock += 300001;
		runInterval();
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(handOffTask).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[sidebar-review] Task task-1: still stuck after continue; no handoff agent is available",
		);
		service.dispose();
	});

	it("does not recheck quota after a silent running task finishes its turn", async () => {
		const clock = 1_000_000;
		const { service, listeners, runInterval } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			session: { ...summary("task-1", "running"), lastOutputAt: clock - 300001 },
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "continue", sessionId: "task-1" }),
		);
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(handOffTask).not.toHaveBeenCalled();
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);
		service.dispose();
	});

	it("resets the nudge for a new turn without handing off", async () => {
		let clock = 1_000_000;
		const { service, runInterval, setSessionSummary } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => clock,
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
		});
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		setSessionSummary({
			...summary("task-1", "running"),
			latestTurnCheckpoint: { turn: 2, ref: "main", commit: "abc", createdAt: clock },
		});
		clock += 300000;
		runInterval();
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(handOffTask).not.toHaveBeenCalled();
		service.dispose();
	});

	it("hands off a running task immediately when its terminal shows a usage limit", async () => {
		const { service, runInterval } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => 1_000_000,
			session: { ...summary("task-1", "running"), lastOutputAt: 969_999 },
			getRestoreSnapshot: async () => ({ snapshot: "Free usage limit reached", cols: 80, rows: 24 }),
		});
		runInterval();
		await vi.waitFor(() => expect(handOffTask).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("ignores a running task screen quota while output is recent", async () => {
		const readOpenCodeLog = vi.fn(async () => null);
		const readAntigravityLogs = vi.fn(async () => []);
		const { service, runInterval } = await startUsageLimitTurn({
			agentId: "codex",
			now: () => 1_000_000,
			session: { ...summary("task-1", "running"), lastOutputAt: 971_000 },
			getRestoreSnapshot: async () => ({ snapshot: "Free usage limit reached", cols: 80, rows: 24 }),
			readOpenCodeLog,
			readAntigravityLogs,
		});
		runInterval();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(handOffTask).not.toHaveBeenCalled();
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(readOpenCodeLog).not.toHaveBeenCalled();
		expect(readAntigravityLogs).not.toHaveBeenCalled();
		service.dispose();
	});

	it("hands off an Antigravity task when its matching log has a quota error", async () => {
		const { service, runInterval } = await startUsageLimitTurn({
			agentId: "antigravity",
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
			readAntigravityLogs: async () => [
				{
					fileName: "cli-20261030_153449.log",
					text: "I1030 15:34:49.929249 server.go:307] Creating CLI server backend: product=antigravity workspaceDirs=[/worktree/task-1 /worktree/task-1]\nE1030 15:34:55.121136 errorreport.go:224] RESOURCE_EXHAUSTED: Individual quota reached.",
				},
			],
		});
		runInterval();
		await vi.waitFor(() =>
			expect(handOffTask).toHaveBeenCalledWith("task-1", "The previous agent hit its usage limit."),
		);
		service.dispose();
	});

	it("sends Enter for a silent running Antigravity task", async () => {
		const { service, runInterval, writeInput } = await startUsageLimitTurn({
			agentId: "opencode",
			now: () => 1_000_000,
			session: { ...summary("task-1", "running"), agentId: "antigravity", lastOutputAt: 699_999 },
			getRestoreSnapshot: async () => ({ snapshot: "clean terminal", cols: 80, rows: 24 }),
		});
		runInterval();
		await vi.waitFor(() => expect(writeInput).toHaveBeenCalledTimes(1));
		expect(writeInput.mock.calls[0]?.[1].toString()).toBe("\r");
		expect(handOffTask).not.toHaveBeenCalled();
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("retries quota-blocked tasks after one hour, not before", async () => {
		let clock = 10_000_000;
		let tick: (() => void) | undefined;
		const { service } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			quotaBlockedAt: clock - 3_599_999,
			now: () => clock,
			setInterval: (callback: () => void) => {
				tick = callback;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
		});
		expect(retryQuotaBlockedTask).not.toHaveBeenCalled();
		tick?.();
		await vi.waitFor(() => expect(retryQuotaBlockedTask).not.toHaveBeenCalled());
		clock += 1;
		tick?.();
		await vi.waitFor(() =>
			expect(retryQuotaBlockedTask).toHaveBeenCalledWith(
				"task-1",
				"Every agent hit their usage limit. Kanban waited 1 hour and is retrying with you.",
			),
		);
		await vi.waitFor(() =>
			expect(recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
				type: "retry",
				agentId: "codex",
				round: 0,
				detail: "Every agent hit their usage limit. Kanban waited 1 hour and is retrying with you.",
			}),
		);
		service.dispose();
	});

	it.each([
		{ columnId: "in_progress", reviewEnabled: true },
		{ columnId: "review", reviewEnabled: false },
	])(
		"does not retry a blocked task outside active Review ($columnId, $reviewEnabled)",
		async ({ columnId, reviewEnabled }) => {
			const { service } = await startUsageLimitTurn({
				agentId: "opencode",
				handOffCount: 2,
				quotaBlockedAt: 1,
				now: () => 3_600_001,
				columnId,
				reviewEnabled,
			});
			await service.notifyBoardChanged();
			expect(retryQuotaBlockedTask).not.toHaveBeenCalled();
			service.dispose();
		},
	);

	it("retries due blocked tasks on start without restoring their review round", async () => {
		const { service } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			quotaBlockedAt: 1,
			reviewRound: 2,
			sidebarIdle: true,
			now: () => 3_600_001,
		});
		expect(retryQuotaBlockedTask).toHaveBeenCalledTimes(1);
		expect(sendPromptToSession).not.toHaveBeenCalled();
		service.dispose();
	});

	it("resets the retry time and warns when a quota retry is refused", async () => {
		retryQuotaBlockedTask.mockResolvedValue({ ok: false, error: "x" });
		const { service, warn } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			quotaBlockedAt: 1,
			now: () => 7_200_001,
		});
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].quotaBlockedAt).toBe(7_200_001));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("x"));
		service.dispose();
	});

	it.each([
		{ columnId: "done", reviewEnabled: true },
		{ columnId: "review", reviewEnabled: false },
	])("clears quota state after board changes ($columnId, $reviewEnabled)", async ({ columnId, reviewEnabled }) => {
		const { service } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			quotaBlockedAt: 10,
		});
		workspaceState.board.columns[0].id = columnId;
		workspaceState.board.columns[0].cards[0].agentReviewEnabled = reviewEnabled;
		await service.notifyBoardChanged();
		expect(workspaceState.board.columns[0].cards[0]).not.toHaveProperty("quotaBlockedAt");
		service.dispose();
	});

	it("clears quota state at turn end and continues the normal review path", async () => {
		const { listeners, service } = await startUsageLimitTurn({
			agentId: "codex",
			quotaBlockedAt: 10,
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(workspaceState.board.columns[0].cards[0]).not.toHaveProperty("quotaBlockedAt");
		service.dispose();
	});

	it("clears quota state before nudging an empty task", async () => {
		const { card, listeners, service } = await startUsageLimitTurn({
			agentId: "codex",
			quotaBlockedAt: 10,
		});
		runGit
			.mockReset()
			.mockResolvedValueOnce({ ok: true, stdout: "" })
			.mockResolvedValueOnce({ ok: true, stdout: "0" });
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(workspaceState.board.columns[0].cards[0]).not.toHaveProperty("quotaBlockedAt");
		expect(card.reviewRound).toBe(0);
		service.dispose();
	});

	it("clears the quota retry interval on dispose", async () => {
		let clock = 10;
		let tick: (() => void) | undefined;
		let active = true;
		const clearInterval = vi.fn(() => {
			active = false;
		});
		const { service } = await startUsageLimitTurn({
			agentId: "opencode",
			handOffCount: 2,
			quotaBlockedAt: 1,
			now: () => clock,
			setInterval: (callback: () => void) => {
				tick = callback;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval,
		});
		service.dispose();
		clock = 3_600_001;
		if (active) tick?.();
		expect(retryQuotaBlockedTask).not.toHaveBeenCalled();
		expect(clearInterval).toHaveBeenCalledTimes(1);
	});

	it("continues the normal review path when handoff is refused", async () => {
		handOffTask.mockResolvedValue({ ok: false, error: "unavailable" });
		const { listeners, warn, service } = await startUsageLimitTurn({
			agentId: "codex",
			getRestoreSnapshot: async () => ({ snapshot: "Free usage limit reached", cols: 80, rows: 24 }),
		});
		const reviewSummary = summary("task-1", "awaiting_review");
		runGit
			.mockReset()
			.mockResolvedValueOnce({ ok: true, stdout: " M file" })
			.mockResolvedValueOnce({ ok: true, stdout: "0" });
		for (const listener of listeners) listener(reviewSummary);
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(sendPromptToSession).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith("[sidebar-review] Could not hand off task task-1: unavailable");
		service.dispose();
	});

	it.each([null, "Task completed with changes"])(
		"keeps the normal review path without a quota phrase (%s)",
		async (snapshot) => {
			const { listeners, service } = await startUsageLimitTurn({
				agentId: "codex",
				getRestoreSnapshot: async () => (snapshot === null ? null : { snapshot, cols: 80, rows: 24 }),
			});
			for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
			await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
			expect(handOffTask).not.toHaveBeenCalled();
			service.dispose();
		},
	);

	it("warns and continues the normal path when the terminal snapshot throws", async () => {
		const { listeners, warn, service } = await startUsageLimitTurn({
			agentId: "codex",
			getRestoreSnapshot: async () => {
				throw new Error("terminal unavailable");
			},
		});
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(warn).toHaveBeenCalledWith(
			"[sidebar-review] Could not check usage limit for task-1: terminal unavailable",
		);
		service.dispose();
	});

	it("nudges the task once when its worktree is empty", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		runGit.mockReset();
		runGit.mockResolvedValueOnce({ ok: true, stdout: "" }).mockResolvedValueOnce({ ok: true, stdout: "0" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "task-1",
				agentId: "claude",
				prompt:
					"[Kanban] No changes found in your worktree (git status is clean and there are no commits since main). The task is not done. Make the changes the task asks for, run every acceptance command, and paste the output.",
			}),
		);
		expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(0);
		service.dispose();
	});

	it("wakes the sidebar after a second empty turn following a nudge", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		runGit.mockReset();
		runGit
			.mockResolvedValueOnce({ ok: true, stdout: "" })
			.mockResolvedValueOnce({ ok: true, stdout: "0" })
			.mockResolvedValueOnce({ ok: true, stdout: "" })
			.mockResolvedValueOnce({ ok: true, stdout: "0" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		for (const listener of listeners) listener(summary("task-1", "running"));
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		for (const listener of listeners) listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(sendPromptToSession.mock.calls[1]?.[0].sessionId).toBe("__home_agent__:workspace-1:claude");
		service.dispose();
	});

	it("wakes the sidebar without a nudge when the worktree has changes", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
			handOffTask,
			retryQuotaBlockedTask,
		});
		runGit.mockReset();
		runGit.mockResolvedValueOnce({ ok: true, stdout: " M file" }).mockResolvedValueOnce({ ok: true, stdout: "0" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		for (const listener of listeners) listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession.mock.calls[0]?.[0].sessionId).toBe("__home_agent__:workspace-1:claude");
		service.dispose();
	});

	it("wakes the sidebar when the worktree git check fails", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const warn = vi.fn();
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn,
			handOffTask,
			retryQuotaBlockedTask,
		});
		runGit.mockReset();
		runGit.mockResolvedValueOnce({ ok: false, stdout: "", error: "missing worktree" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		for (const listener of listeners) listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession.mock.calls[0]?.[0].sessionId).toBe("__home_agent__:workspace-1:claude");
		expect(warn).toHaveBeenCalled();
		service.dispose();
	});

	describe.each(["blocked", "waiting"] as const)("%s report", (reportState) => {
		const settle = async () => await new Promise((resolve) => setTimeout(resolve, 25));
		const block = () => {
			const card = workspaceState.board.columns[0].cards[0];
			if (reportState === "blocked") card.blockedReport = { question: "A or B?", reportedAt: 1 };
			else card.waitingReport = { reason: "Experiment", reportedAt: 1 };
		};
		const quotaScreen = async () => ({ snapshot: "You’ve hit your usage limit", cols: 80, rows: 24 });

		it("does not restore a waiting review on startup", async () => {
			block();
			const { service } = await startUsageLimitTurn({ agentId: "claude", reviewRound: 1, sidebarIdle: true });
			expect(sendPromptToSession).not.toHaveBeenCalled();
			service.dispose();
		});

		it("drops an already queued review before the sidebar becomes idle", async () => {
			const { listeners, service } = await startUsageLimitTurn({ agentId: "claude" });
			for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
			await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
			block();
			for (const listener of listeners) listener(summary("__home_agent__:workspace-1:claude", "running"));
			for (const listener of listeners) listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
			await settle();
			expect(sendPromptToSession).not.toHaveBeenCalled();
			service.dispose();
		});

		it("does not queue a review or count a round on turn end, until the report clears", async () => {
			block();
			const { card, listeners, service } = await startUsageLimitTurn({ agentId: "claude" });
			for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
			await settle();
			expect(card.reviewRound).toBe(0);
			expect(sendPromptToSession).not.toHaveBeenCalled();
			expect(runGit).not.toHaveBeenCalled();
			delete card.blockedReport;
			delete card.waitingReport;
			for (const listener of listeners) listener(summary("task-1", "running"));
			for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
			await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
			service.dispose();
		});

		it("does not hand off a crashed blocked task", async () => {
			block();
			const { card, listeners, service } = await startUsageLimitTurn({ agentId: "codex" });
			for (const listener of listeners) listener({ ...summary("task-1", "failed"), agentId: "codex", exitCode: 7 });
			await settle();
			expect(handOffTask).not.toHaveBeenCalled();
			expect(card.reviewRound).toBe(0);
			service.dispose();
		});

		it("does not hand off a blocked task when the screen shows a usage limit at turn end", async () => {
			block();
			const { listeners, service } = await startUsageLimitTurn({
				agentId: "codex",
				getRestoreSnapshot: quotaScreen,
			});
			for (const listener of listeners)
				listener({ ...summary("task-1", "awaiting_review"), agentId: "codex" as const });
			await settle();
			expect(handOffTask).not.toHaveBeenCalled();
			expect(sendPromptToSession).not.toHaveBeenCalled();
			service.dispose();
		});

		it("does not nudge a silent running blocked task", async () => {
			block();
			const { service, runInterval } = await startUsageLimitTurn({ agentId: "codex", now: () => 1_000_000 });
			runInterval();
			await settle();
			expect(sendPromptToSession).not.toHaveBeenCalled();
			expect(handOffTask).not.toHaveBeenCalled();
			service.dispose();
		});

		it("does not hand off a running blocked task whose screen shows a quota phrase", async () => {
			block();
			const { service, runInterval } = await startUsageLimitTurn({
				agentId: "codex",
				now: () => 1_000_000,
				session: { ...summary("task-1", "running"), lastOutputAt: 969_999 },
				getRestoreSnapshot: quotaScreen,
			});
			runInterval();
			await settle();
			expect(handOffTask).not.toHaveBeenCalled();
			expect(sendPromptToSession).not.toHaveBeenCalled();
			service.dispose();
		});

		it("skips a blocked task in the hourly quota retry", async () => {
			block();
			let tick: (() => void) | undefined;
			const { service } = await startUsageLimitTurn({
				agentId: "opencode",
				handOffCount: 2,
				quotaBlockedAt: 1,
				now: () => 3_600_001,
				setInterval: (callback: () => void) => {
					tick = callback;
					return 1 as unknown as ReturnType<typeof setInterval>;
				},
			});
			tick?.();
			await settle();
			expect(retryQuotaBlockedTask).not.toHaveBeenCalled();
			service.dispose();
		});
	});
});
