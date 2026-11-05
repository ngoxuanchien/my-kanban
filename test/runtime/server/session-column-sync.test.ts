import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { type LockRequest, lockedFileSystem } from "../../../src/fs/locked-file-system";
import { clearBlockedReportOnRun } from "../../../src/server/blocked-report-clearing";
import { createSessionColumnSync } from "../../../src/server/session-column-sync";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceContext,
	loadWorkspaceState,
	saveWorkspaceState,
	WorkspaceStateConflictError,
} from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function summary(state: RuntimeTaskSessionSummary["state"], taskId = "task-1"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function summarySource(initial: RuntimeTaskSessionSummary[] = []) {
	const summaries = new Map(initial.map((value) => [value.taskId, value]));
	const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
	return {
		listSummaries: () => [...summaries.values()],
		onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit: (value: RuntimeTaskSessionSummary) => {
			summaries.set(value.taskId, value);
			for (const listener of listeners) listener(value);
		},
	};
}

describe.sequential("session column sync", () => {
	let workspacePath: string;
	let workspaceId: string;
	let cleanup: () => void;
	let service: ReturnType<typeof createSessionColumnSync>;
	let terminal: ReturnType<typeof summarySource>;
	let cline: ReturnType<typeof summarySource>;
	let onBoardMoved: ReturnType<typeof vi.fn<() => Promise<void>>>;
	let warn: ReturnType<typeof vi.fn<(message: string) => void>>;

	beforeEach(async () => {
		const sandbox = createTempDir("kanban-column-sync-");
		cleanup = sandbox.cleanup;
		vi.stubEnv("HOME", join(sandbox.path, "home"));
		workspacePath = join(sandbox.path, "repo");
		mkdirSync(workspacePath, { recursive: true });
		const result = spawnSync("git", ["init", "-b", "main"], {
			cwd: workspacePath,
			encoding: "utf8",
			env: createGitTestEnv(),
		});
		expect(result.status, result.stderr).toBe(0);
		workspaceId = (await loadWorkspaceContext(workspacePath)).workspaceId;
		terminal = summarySource();
		cline = summarySource();
		onBoardMoved = vi.fn(async () => {});
		warn = vi.fn();
		service = createSessionColumnSync({
			workspaceId,
			workspacePath,
			terminalManager: terminal,
			clineService: cline,
			onBoardMoved,
			warn,
		});
	});

	afterEach(() => {
		service?.stop();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		cleanup();
	});

	async function saveCard(
		columnId: RuntimeBoardColumnId,
		sessions: RuntimeTaskSessionSummary[] = [],
		taskId = "task-1",
		blockedReport?: { question: string; reportedAt: number },
		waitingReport?: RuntimeBoardCard["waitingReport"],
	) {
		const initial = await loadWorkspaceState(workspacePath);
		return await saveWorkspaceState(workspacePath, {
			expectedRevision: initial.revision,
			board: {
				...initial.board,
				columns: initial.board.columns.map((column) => ({
					...column,
					cards: [
						...(column.id === columnId ? [taskId] : []),
						...(column.id === "review" || column.id === "in_progress" ? [`existing-${column.id}`] : []),
					].map((id) => ({
						id,
						title: id,
						prompt: id,
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 1,
						updatedAt: 1,
						...(id === taskId && blockedReport ? { blockedReport } : {}),
						...(id === taskId && waitingReport ? { waitingReport } : {}),
					})),
				})),
			},
			sessions: Object.fromEntries(sessions.map((value) => [value.taskId, value])),
		});
	}

	async function emit(value: RuntimeTaskSessionSummary, source = terminal) {
		const handled = new Promise<void>((resolve) => {
			const unsubscribe = service.onSummary((event) => {
				if (event.summary !== value) return;
				unsubscribe();
				resolve();
			});
		});
		source.emit(value);
		await handled;
	}

	it.each(["terminal", "cline"] as const)(
		"moves in_progress to review on running→awaiting_review (%s)",
		async (source) => {
			await saveCard("in_progress", [summary("running")]);
			await service.start();
			await emit(summary("awaiting_review"), source === "terminal" ? terminal : cline);
			const state = await loadWorkspaceState(workspacePath);
			expect(state.board.columns.find((column) => column.id === "review")?.cards.map((card) => card.id)).toEqual([
				"task-1",
				"existing-review",
			]);
			expect(
				state.board.columns.find((column) => column.id === "in_progress")?.cards.map((card) => card.id),
			).toEqual(["existing-in_progress"]);
		},
	);

	it.each(["terminal", "cline"] as const)("review to in_progress on awaiting_review→running (%s)", async (source) => {
		await saveCard("review", [summary("awaiting_review")]);
		await service.start();
		await emit(summary("running"), source === "terminal" ? terminal : cline);
		const state = await loadWorkspaceState(workspacePath);
		expect(state.board.columns.find((column) => column.id === "in_progress")?.cards.map((card) => card.id)).toEqual([
			"task-1",
			"existing-in_progress",
		]);
		expect(state.board.columns.find((column) => column.id === "review")?.cards.map((card) => card.id)).toEqual([
			"existing-review",
		]);
	});

	it("ignores activity-only updates", async () => {
		const initial = await saveCard("review", [summary("running")]);
		await service.start();
		await emit({ ...summary("running"), updatedAt: 2, lastOutputAt: 2 });
		const state = await loadWorkspaceState(workspacePath);
		expect(state.board).toEqual(initial.board);
		expect(state.revision).toBe(initial.revision);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it("permission waits stay in_progress without a write", async () => {
		const initial = await saveCard("in_progress", [summary("running")]);
		await service.start();
		await emit({
			...summary("running"),
			latestHookActivity: {
				activityText: "Waiting for approval",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "PermissionRequest",
				notificationType: null,
				source: null,
			},
		});
		expect((await loadWorkspaceState(workspacePath)).revision).toBe(initial.revision);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it.each(["persisted", "live"] as const)(
		"start reconciles in_progress cards already awaiting_review (%s)",
		async (source) => {
			await saveCard("in_progress", source === "persisted" ? [summary("awaiting_review")] : []);
			if (source === "live") terminal.emit(summary("awaiting_review"));
			await service.start();
			expect(
				(await loadWorkspaceState(workspacePath)).board.columns.find((column) => column.id === "review")?.cards[0]
					?.id,
			).toBe("task-1");
			expect(onBoardMoved).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["backlog", "trash"] as const)("never moves %s cards", async (columnId) => {
		const initial = await saveCard(columnId, [summary("running")]);
		await service.start();
		await emit(summary("awaiting_review"));
		await emit(summary("running"));
		expect((await loadWorkspaceState(workspacePath)).revision).toBe(initial.revision);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it("never moves home-agent sessions", async () => {
		const taskId = `__home_agent__:${workspaceId}:codex`;
		const initial = await saveCard("in_progress", [summary("awaiting_review", taskId)], taskId);
		await service.start();
		await emit(summary("running", taskId));
		await emit(summary("awaiting_review", taskId));
		expect((await loadWorkspaceState(workspacePath)).revision).toBe(initial.revision);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it("calls onBoardMoved once per move", async () => {
		await saveCard("in_progress", [summary("running")]);
		await service.start();
		await emit(summary("awaiting_review"));
		await emit(summary("awaiting_review"));
		expect(onBoardMoved).toHaveBeenCalledTimes(1);
		await emit(summary("running"));
		expect(onBoardMoved).toHaveBeenCalledTimes(2);
	});

	it("stale-revision UI save after a move is rejected and the move stays", async () => {
		const stale = await saveCard("in_progress", [summary("running")]);
		await service.start();
		await emit(summary("awaiting_review"));
		await expect(
			saveWorkspaceState(workspacePath, {
				board: stale.board,
				sessions: stale.sessions,
				expectedRevision: stale.revision,
			}),
		).rejects.toBeInstanceOf(WorkspaceStateConflictError);
		const state = await loadWorkspaceState(workspacePath);
		expect(state.board.columns.find((column) => column.id === "review")?.cards[0]?.id).toBe("task-1");
		expect(state.board.columns.flatMap((column) => column.cards).filter((card) => card.id === "task-1")).toHaveLength(
			1,
		);
	});

	it("re-emits summary and previous after the saved move for transition consumers", async () => {
		const previous = summary("running");
		await saveCard("in_progress", [previous]);
		await service.start();
		const events: unknown[] = [];
		const unsubscribe = service.onSummary((event) => {
			events.push(event);
		});
		const next = summary("awaiting_review");
		await emit(next);
		expect(events).toEqual([{ summary: next, previous, waitingReportCleared: false }]);
		expect(onBoardMoved).toHaveBeenCalledTimes(1);
		unsubscribe();
		await emit(summary("running"));
		expect(events).toHaveLength(1);
	});

	it("serializes rapid transitions and stops both subscriptions", async () => {
		await saveCard("in_progress", [summary("running")]);
		await service.start();
		terminal.emit(summary("awaiting_review"));
		await emit(summary("running"), cline);
		expect(onBoardMoved).toHaveBeenCalledTimes(2);
		service.stop();
		terminal.emit(summary("awaiting_review"));
		cline.emit(summary("awaiting_review"));
		expect(
			(await loadWorkspaceState(workspacePath)).board.columns.find((column) => column.id === "in_progress")?.cards[0]
				?.id,
		).toBe("task-1");
		expect(onBoardMoved).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not save or notify after stopping while a move waits for its lock", async () => {
		const initial = await saveCard("in_progress", [summary("running")]);
		await service.start();
		let release: () => void = () => {};
		let entered: () => void = () => {};
		let finished: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waitingForLock = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const completed = new Promise<void>((resolve) => {
			finished = resolve;
		});
		const withLock = lockedFileSystem.withLock.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "withLock").mockImplementation(
			async <T>(request: LockRequest, operation: () => Promise<T>): Promise<T> => {
				if (request.path !== getWorkspaceDirectoryPath(workspaceId)) return await withLock(request, operation);
				entered();
				await gate;
				try {
					return await withLock(request, operation);
				} finally {
					finished();
				}
			},
		);
		terminal.emit(summary("awaiting_review"));
		await waitingForLock;
		service.stop();
		release();
		await completed;
		const state = await loadWorkspaceState(workspacePath);
		expect(state.revision).toBe(initial.revision);
		expect(state.board).toEqual(initial.board);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it("does not notify after stopping as an atomic save finishes", async () => {
		await saveCard("in_progress", [summary("running")]);
		await service.start();
		let finished: () => void = () => {};
		const completed = new Promise<void>((resolve) => {
			finished = resolve;
		});
		const withLock = lockedFileSystem.withLock.bind(lockedFileSystem);
		vi.spyOn(lockedFileSystem, "withLock").mockImplementation(
			async <T>(request: LockRequest, operation: () => Promise<T>): Promise<T> => {
				const result = await withLock(request, operation);
				if (request.path === getWorkspaceDirectoryPath(workspaceId)) {
					service.stop();
					finished();
				}
				return result;
			},
		);
		terminal.emit(summary("awaiting_review"));
		await completed;
		expect(
			(await loadWorkspaceState(workspacePath)).board.columns.find((column) => column.id === "review")?.cards[0]?.id,
		).toBe("task-1");
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	const waiting = { reason: "Experiment: 3 hours", reportedAt: 10, pid: 12345 };
	const waitingTask = async () =>
		(await loadWorkspaceState(workspacePath)).board.columns
			.flatMap((column) => column.cards)
			.find((card) => card.id === "task-1");

	it("keeps waiting cards in progress at turn end and on startup", async () => {
		await saveCard("in_progress", [summary("awaiting_review")], "task-1", undefined, waiting);
		await service.start();
		await emit({ ...summary("running"), updatedAt: 5 });
		await emit({ ...summary("awaiting_review"), updatedAt: 6 });
		const state = await loadWorkspaceState(workspacePath);
		expect(state.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.waitingReport).toEqual(
			waiting,
		);
		expect(onBoardMoved).not.toHaveBeenCalled();
	});

	it.each([5, 10, 11])("clears waiting only on a fresh running transition (%s)", async (updatedAt) => {
		await saveCard("in_progress", [summary("awaiting_review")], "task-1", undefined, waiting);
		await service.start();
		await emit({ ...summary("running"), updatedAt });
		expect((await waitingTask())?.waitingReport).toEqual(updatedAt > 10 ? undefined : waiting);
	});

	it("keeps waiting while the reporting turn is still running", async () => {
		await saveCard("in_progress", [summary("running")], "task-1", undefined, waiting);
		await service.start();
		await emit({ ...summary("running"), updatedAt: 11 });
		expect((await waitingTask())?.waitingReport).toEqual(waiting);
	});

	it.each(["failed", "interrupted", "idle", "awaiting_review"] as const)(
		"clears waiting and moves to Review on session exit/error (%s)",
		async (state) => {
			await saveCard("in_progress", [summary("running")], "task-1", undefined, waiting);
			await service.start();
			await emit({ ...summary(state), updatedAt: 11, reviewReason: state === "awaiting_review" ? "exit" : "error" });
			expect((await waitingTask())?.waitingReport).toBeUndefined();
			expect(
				(await loadWorkspaceState(workspacePath)).board.columns
					.find((column) => column.id === "review")
					?.cards.map((card) => card.id),
			).toContain("task-1");
		},
	);

	describe("blocked report clearing", () => {
		const reportedTask = async () => {
			const state = await loadWorkspaceState(workspacePath);
			return state.board.columns.flatMap((column) => column.cards).find((card) => card.id === "task-1");
		};
		const emitRunning = async (updatedAt: number) => {
			let clearBlockedReport: ReturnType<typeof clearBlockedReportOnRun> | undefined;
			const unsubscribe = service.onSummary((event) => {
				clearBlockedReport = clearBlockedReportOnRun(workspacePath, event);
			});
			terminal.emit({ ...summary("running"), updatedAt });
			await vi.waitFor(() => expect(clearBlockedReport).toBeDefined());
			unsubscribe();
			await clearBlockedReport;
		};

		it("clears when the session transitions to running after reportedAt", async () => {
			await saveCard("review", [summary("awaiting_review")], "task-1", { question: "A or B?", reportedAt: 0 });
			await service.start();
			await emitRunning(5);
			expect((await reportedTask())?.blockedReport).toBeUndefined();
		});

		it("keeps the report when the running summary predates reportedAt", async () => {
			await saveCard("review", [summary("awaiting_review")], "task-1", { question: "A or B?", reportedAt: 9 });
			await service.start();
			await emitRunning(5);
			expect((await reportedTask())?.blockedReport).toEqual({ question: "A or B?", reportedAt: 9 });
		});

		it("keeps the report while a session that was already running keeps updating", async () => {
			await saveCard("in_progress", [summary("running")], "task-1", { question: "A or B?", reportedAt: 0 });
			await service.start();
			await emitRunning(5);
			expect((await reportedTask())?.blockedReport).toEqual({ question: "A or B?", reportedAt: 0 });
		});
	});
});
