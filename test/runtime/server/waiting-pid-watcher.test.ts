import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAgentId, RuntimeBoardData, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { moveTaskToColumn } from "../../../src/core/task-board-mutations";
import { clearWaitingReport, isTaskWaiting } from "../../../src/core/waiting-report";
import { createWaitingPidWatcher, isPidAlive } from "../../../src/server/waiting-pid-watcher";
import type { SendPromptToSessionResult } from "../../../src/terminal/send-prompt-to-session";

const mocks = vi.hoisted(() => ({
	state: {
		board: { columns: [], dependencies: [] } as RuntimeBoardData,
		sessions: {} as Record<string, RuntimeTaskSessionSummary>,
	},
	send: vi.fn(
		async (_input: {
			sessionId: string;
			prompt: string;
			agentId: RuntimeAgentId | null;
		}): Promise<SendPromptToSessionResult> => ({ ok: true }),
	),
}));
vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceState: vi.fn(async () => mocks.state),
	mutateWorkspaceState: vi.fn(async (_path, mutate) => {
		const result = mutate(mocks.state);
		if (result.save !== false) mocks.state.board = result.board;
		return { saved: result.save !== false, value: result.value };
	}),
}));
vi.mock("../../../src/terminal/send-prompt-to-session", () => ({ sendPromptToSession: mocks.send }));

function session(
	state: RuntimeTaskSessionSummary["state"] = "running",
	pid: number | null = 555,
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		agentId: "codex",
		state,
		pid,
		startedAt: 1,
		updatedAt: 2,
		workspacePath: null,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}
function task() {
	return mocks.state.board.columns.flatMap((column) => column.cards)[0];
}

describe("waiting pid watcher", () => {
	let watcher: ReturnType<typeof createWaitingPidWatcher>;
	let alive: ReturnType<typeof vi.fn<(pid: number) => boolean>>;
	let broadcast: ReturnType<typeof vi.fn<() => void>>;
	let warn: ReturnType<typeof vi.fn<(message: string) => void>>;
	let summaries: RuntimeTaskSessionSummary[];
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);
		mocks.send.mockReset().mockResolvedValue({ ok: true });
		mocks.state.board = {
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
							createdAt: 0,
							updatedAt: 0,
							waitingReport: { reason: "Experiment", reportedAt: 1, pid: 12345 },
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		mocks.state.sessions = {};
		summaries = [session()];
		alive = vi.fn(() => true);
		broadcast = vi.fn();
		warn = vi.fn();
		watcher = createWaitingPidWatcher({
			workspacePath: "/repo",
			listSummaries: () => summaries,
			sendPrompt: (input) => mocks.send(input),
			broadcastStateUpdated: broadcast,
			warn,
			isPidAlive: alive,
		});
	});
	afterEach(() => {
		watcher.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("checks once at startup and every 30s, leaving an alive pid alone", async () => {
		await watcher.start();
		expect(alive).toHaveBeenCalledExactlyOnceWith(12345);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(alive).toHaveBeenCalledTimes(2);
		expect(isTaskWaiting(task())).toBe(true);
		expect(mocks.send).not.toHaveBeenCalled();
		expect(broadcast).not.toHaveBeenCalled();
	});

	it.each(["running", "awaiting_review"] as const)(
		"wakes a live %s session once on pid exit and clears the report",
		async (state) => {
			summaries = [session(state)];
			await watcher.start();
			alive.mockReturnValue(false);
			await vi.advanceTimersByTimeAsync(30_000);
			expect(mocks.send).toHaveBeenCalledExactlyOnceWith({
				sessionId: "task-1",
				agentId: "codex",
				prompt: "[Kanban] Background job 12345 exited. Check its output and continue the task.",
			});
			expect(task()).not.toHaveProperty("waitingReport");
			expect(mocks.state.board.columns[0].cards).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(mocks.send).toHaveBeenCalledTimes(1);
			expect(broadcast).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["stopped", "missing", "delivery failed"])(
		"clears and moves to Review at startup when the session is %s",
		async (kind) => {
			alive.mockReturnValue(false);
			summaries = kind === "missing" ? [] : [kind === "stopped" ? session("awaiting_review", null) : session()];
			if (kind === "delivery failed") mocks.send.mockResolvedValue({ ok: false, reason: "session_not_running" });
			await watcher.start();
			expect(mocks.state.board.columns[0].cards).toHaveLength(0);
			expect(mocks.state.board.columns[1].cards[0]).not.toHaveProperty("waitingReport");
			if (kind !== "delivery failed") expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it("does not watch a report without a pid", async () => {
		delete task().waitingReport?.pid;
		await watcher.start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(alive).not.toHaveBeenCalled();
	});

	it("stop cancels the unref'd timer and later checks", async () => {
		await watcher.start();
		expect(vi.getTimerCount()).toBe(1);
		watcher.stop();
		expect(vi.getTimerCount()).toBe(0);
		alive.mockReturnValue(false);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(alive).toHaveBeenCalledTimes(1);
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("keeps a newly replaced report while delivery is in flight", async () => {
		alive.mockReturnValue(false);
		mocks.send.mockImplementationOnce(async () => {
			task().waitingReport = { reason: "Another experiment", reportedAt: Date.now(), pid: 999 };
			return { ok: true };
		});
		await watcher.start();
		expect(task().waitingReport?.pid).toBe(999);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it("does not move a task that was completed during delivery", async () => {
		alive.mockReturnValue(false);
		mocks.send.mockImplementationOnce(async () => {
			mocks.state.board = moveTaskToColumn(mocks.state.board, "task-1", "trash").board;
			return { ok: false, reason: "session_not_running" };
		});
		await watcher.start();
		expect(mocks.state.board.columns[2].cards).toHaveLength(1);
		expect(mocks.state.board.columns[1].cards).toHaveLength(0);
	});

	it("clearWaitingReport keeps unrelated cards and fields", () => {
		const original = mocks.state.board;
		const cleared = clearWaitingReport(original, "task-1");
		expect(cleared.columns[0].cards[0]).not.toHaveProperty("waitingReport");
		expect(cleared.columns[0].cards[0].title).toBe("Task");
		expect(original.columns[0].cards[0].waitingReport).toBeDefined();
	});
});

describe("pid liveness", () => {
	afterEach(() => vi.restoreAllMocks());
	it("uses signal zero", () => {
		const kill = vi.spyOn(process, "kill").mockReturnValue(true);
		expect(isPidAlive(12345)).toBe(true);
		expect(kill).toHaveBeenCalledWith(12345, 0);
	});
	it.each([
		["ESRCH", false],
		["EPERM", true],
	] as const)("handles %s", (code, expected) => {
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw Object.assign(new Error(code), { code });
		});
		expect(isPidAlive(12345)).toBe(expected);
	});
	it("propagates unexpected errors", () => {
		vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("unexpected");
		});
		expect(() => isPidAlive(12345)).toThrow("unexpected");
	});
});
