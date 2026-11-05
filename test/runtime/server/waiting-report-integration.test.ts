import { afterEach, expect, it, vi } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { createSessionColumnSync } from "../../../src/server/session-column-sync";
import { createSidebarReviewService } from "../../../src/server/sidebar-review-service";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const storage = vi.hoisted(() => ({ board: { columns: [], dependencies: [] } as RuntimeBoardData }));
vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceState: vi.fn(async () => ({ board: storage.board, sessions: {} })),
	mutateWorkspaceState: vi.fn(async (_path, mutate) => {
		const result = mutate({ board: storage.board, sessions: {} });
		if (result.save !== false) storage.board = result.board;
		return { saved: result.save !== false, value: result.value };
	}),
}));

afterEach(() => vi.useRealTimers());

it.each([
	{ waiting: true, state: "failed" },
	{ waiting: true, state: "awaiting_review" },
	{ waiting: false, state: "failed" },
] as const)("handles a $state crash with waiting=$waiting after cleanup", async ({ waiting, state }) => {
	vi.useFakeTimers();
	storage.board = {
		columns: [
			{
				id: "in_progress",
				title: "In progress",
				cards: [
					{
						id: "task-1",
						title: "Task",
						prompt: "Task",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 1,
						updatedAt: 1,
						agentId: "codex",
						agentReviewEnabled: true,
						...(waiting ? { waitingReport: { reason: "Experiment", reportedAt: 10 } } : {}),
					},
				],
			},
			{ id: "review", title: "Review", cards: [] },
		],
		dependencies: [],
	};
	let current: RuntimeTaskSessionSummary = {
		taskId: "task-1",
		state: "running",
		agentId: "codex",
		workspacePath: "/repo",
		pid: 123,
		startedAt: 1,
		updatedAt: 5,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
	const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
	const terminal = {
		listSummaries: () => [current],
		onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as TerminalSessionManager;
	const cline = { listSummaries: () => [], onSummary: () => () => {} } as unknown as ClineTaskSessionService;
	const sync = createSessionColumnSync({
		workspaceId: "workspace-1",
		workspacePath: "/repo",
		terminalManager: terminal,
		clineService: cline,
		onBoardMoved: async () => {},
		warn: vi.fn(),
	});
	await sync.start();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let deferConfig = false;
	const handOffTask = vi.fn(async () => ({ ok: true }));
	const sidebar = createSidebarReviewService({
		workspaceId: "workspace-1",
		workspacePath: "/repo",
		terminalManager: terminal,
		clineService: cline,
		onSessionSummary: sync.onSummary,
		loadRuntimeConfig: async () => {
			if (deferConfig) await gate;
			return { selectedAgentId: "claude" } as RuntimeConfigState;
		},
		broadcastStateUpdated: vi.fn(),
		warn: vi.fn(),
		handOffTask,
		retryQuotaBlockedTask: vi.fn(async () => ({ ok: true })),
	});
	await sidebar.start();
	try {
		deferConfig = true;
		current = { ...current, state, reviewReason: "error", updatedAt: 11, pid: null, exitCode: 1 };
		const processed = new Promise<void>((resolve) => sync.onSummary(() => resolve()));
		for (const listener of listeners) listener(current);
		await processed;
		if (waiting) expect(storage.board.columns[1].cards[0]).not.toHaveProperty("waitingReport");
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(handOffTask).toHaveBeenCalledTimes(waiting ? 0 : 1);
	} finally {
		release();
		sidebar.dispose();
		sync.stop();
	}
});
