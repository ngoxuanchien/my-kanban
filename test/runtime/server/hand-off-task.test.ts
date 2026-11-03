import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceState = vi.hoisted(() => ({
	board: {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] as Array<Record<string, unknown>> },
			{ id: "in_progress", title: "In Progress", cards: [] as Array<Record<string, unknown>> },
			{ id: "review", title: "Review", cards: [] as Array<Record<string, unknown>> },
			{ id: "trash", title: "Trash", cards: [] as Array<Record<string, unknown>> },
		],
		dependencies: [],
	},
}));
const taskHistory = vi.hoisted(() => ({
	loadTaskHistory: vi.fn(async () => []),
	formatRecentTaskComments: vi.fn(() => ""),
}));

vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceContext: vi.fn(async () => ({ workspaceId: "workspace-1" })),
	loadWorkspaceState: vi.fn(async () => ({ board: workspaceState.board })),
	mutateWorkspaceState: vi.fn(
		async (_path: string, mutate: (state: { board: typeof workspaceState.board }) => unknown) => {
			const result = mutate({ board: workspaceState.board }) as {
				board: typeof workspaceState.board;
				value: unknown;
				save?: boolean;
			};
			if (result.save !== false) workspaceState.board = result.board;
			return { saved: result.save !== false, value: result.value };
		},
	),
}));
vi.mock("../../../src/state/task-history", () => taskHistory);

import { buildHandOffPrompt, type HandOffTaskDependencies, handOffTask } from "../../../src/server/hand-off-task";

const card = (agentId: string | null = "codex") => ({
	id: "task-1",
	title: "Task one",
	prompt: "Finish the task",
	baseRef: "main",
	startInPlanMode: false,
	createdAt: 0,
	updatedAt: 0,
	agentReviewEnabled: true,
	reviewRound: 3,
	...(agentId ? { agentId } : {}),
});

function dependencies(overrides: Partial<HandOffTaskDependencies> = {}) {
	return {
		workspacePath: "/repo",
		stopTaskSession: vi.fn(async () => {}),
		startTaskSession: vi.fn(async () => ({ ok: true })),
		broadcastStateUpdated: vi.fn(),
		...overrides,
	};
}

describe("handOffTask", () => {
	beforeEach(() => {
		workspaceState.board.columns = [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [card()] },
			{ id: "trash", title: "Trash", cards: [] },
		];
		taskHistory.loadTaskHistory.mockResolvedValue([]);
		taskHistory.formatRecentTaskComments.mockReturnValue("");
	});

	it.each([
		["codex", "opencode", 1, ["codex"]],
		["opencode", "antigravity", 2, ["codex", "opencode"]],
	] as const)(
		"switches %s to %s and retains the existing review round",
		async (fromAgentId, toAgentId, handOffCount, previousAgentIds) => {
			workspaceState.board.columns[2]?.cards.splice(0, 1, { ...card(fromAgentId), handOffCount: handOffCount - 1 });
			const events: string[] = [];
			const deps = dependencies({
				stopTaskSession: vi.fn(async () => {
					events.push("stop");
				}),
				startTaskSession: vi.fn(async () => {
					events.push("start");
					return { ok: true };
				}),
			});
			const result = await handOffTask(deps, { taskId: "task-1", reason: "Fix the failing test" });

			expect(result).toEqual({ ok: true, taskId: "task-1", fromAgentId, toAgentId });
			expect(events).toEqual(["stop", "start"]);
			expect(deps.startTaskSession).toHaveBeenCalledWith({
				taskId: "task-1",
				prompt: buildHandOffPrompt({
					originalPrompt: "Finish the task",
					previousAgentIds: [...previousAgentIds],
					baseRef: "main",
					reason: "Fix the failing test",
				}),
				taskTitle: "Task one",
				baseRef: "main",
				agentId: toAgentId,
			});
			const moved = workspaceState.board.columns[1]?.cards[0];
			expect(moved).toMatchObject({ agentId: toAgentId, handOffCount, reviewRound: 3 });
			expect(moved).not.toHaveProperty("handedOff");
			expect(workspaceState.board.columns[2]?.cards).toHaveLength(0);
		},
	);

	it("formats the handoff prompt exactly", () => {
		expect(
			buildHandOffPrompt({
				originalPrompt: "Original",
				previousAgentIds: ["codex"],
				baseRef: "main",
				reason: "Tests fail",
			}),
		).toBe(
			"Original\n\n---\n[Kanban handoff] Another agent (codex) worked on this task before you and could not finish it.\n" +
				"Its unfinished work is already in this worktree (uncommitted changes and commits since main). Check it and continue from it; do not start over.\n" +
				"Why it was handed off: Tests fail",
		);
	});

	it("appends recent comments to the handoff prompt", async () => {
		taskHistory.loadTaskHistory.mockResolvedValue([
			{ type: "comment", agentId: "codex", at: 100, detail: "preserve the current worktree" },
		] as never);
		taskHistory.formatRecentTaskComments.mockReturnValue(
			"Notes from earlier agents:\n- codex, 1970-01-01T00:00:00.100Z: preserve the current worktree",
		);
		const deps = dependencies();
		await handOffTask(deps, { taskId: "task-1", reason: "Need another agent" });
		expect(deps.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: expect.stringContaining("Notes from earlier agents:") }),
		);
	});

	it.each([
		["already handed off twice", { ...card(), handOffCount: 2 }, "Task has already been handed off twice"],
		["review disabled", { ...card(), agentReviewEnabled: false }, "Agent review is not enabled for this task"],
		["claude agent", card("claude"), "Task agent must be codex, opencode, or antigravity to hand off"],
		["unset agent", card(null), "Task agent must be codex, opencode, or antigravity to hand off"],
	])("refuses %s without changing the board", async (_label, refusedCard, error) => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, refusedCard);
		const before = structuredClone(workspaceState.board);
		const deps = dependencies();
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({ ok: false, error });
		expect(workspaceState.board).toEqual(before);
		expect(deps.stopTaskSession).not.toHaveBeenCalled();
		expect(deps.startTaskSession).not.toHaveBeenCalled();
	});

	it("refuses a quota-blocked task without quotaRetry and retries past the handoff cap with quotaRetry", async () => {
		const deps = dependencies();
		const refusedCard = { ...card("antigravity"), handOffCount: 2, quotaBlockedAt: 123 };
		workspaceState.board.columns[2]?.cards.splice(0, 1, refusedCard);

		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({
			ok: false,
			error: "Task has already been handed off twice",
		});
		expect(workspaceState.board.columns[1]?.cards[0]).toBeUndefined();
		expect(deps.stopTaskSession).not.toHaveBeenCalled();

		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason", quotaRetry: true })).toEqual({
			ok: true,
			taskId: "task-1",
			fromAgentId: "antigravity",
			toAgentId: "codex",
		});
		const moved = workspaceState.board.columns[1]?.cards[0];
		expect(moved).toMatchObject({ agentId: "codex", handOffCount: 3 });
		expect(moved).not.toHaveProperty("quotaBlockedAt");
		expect(moved).not.toHaveProperty("handedOff");
		expect(workspaceState.board.columns[2]?.cards).toHaveLength(0);
	});

	it("refuses a quotaRetry handoff when agent review is not enabled", async () => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, { ...card(), agentReviewEnabled: false, handOffCount: 2 });
		const deps = dependencies();
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason", quotaRetry: true })).toEqual({
			ok: false,
			error: "Agent review is not enabled for this task",
		});
		expect(workspaceState.board.columns[1]?.cards).toHaveLength(0);
	});

	it("refuses an unknown id without changing the board", async () => {
		const before = structuredClone(workspaceState.board);
		const deps = dependencies();
		expect(await handOffTask(deps, { taskId: "unknown", reason: "Reason" })).toEqual({
			ok: false,
			error: "Task not found",
		});
		expect(workspaceState.board).toEqual(before);
		expect(deps.stopTaskSession).not.toHaveBeenCalled();
	});

	it("returns a new-session error and keeps the handoff count", async () => {
		const deps = dependencies({ startTaskSession: vi.fn(async () => ({ ok: false, error: "x" })) });
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({ ok: false, error: "x" });
		expect(workspaceState.board.columns[1]?.cards[0]).toMatchObject({ agentId: "opencode", handOffCount: 1 });
		expect(deps.broadcastStateUpdated).toHaveBeenCalledOnce();
	});

	it("maps a legacy opencode handoff to antigravity at count two", async () => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, { ...card("opencode"), handedOff: true });
		const deps = dependencies();
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toMatchObject({
			ok: true,
			toAgentId: "antigravity",
		});
		expect(workspaceState.board.columns[1]?.cards[0]).toMatchObject({ agentId: "antigravity", handOffCount: 2 });
		expect(workspaceState.board.columns[1]?.cards[0]).not.toHaveProperty("handedOff");
		expect(deps.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Other agents (codex, then opencode) worked on this task"),
			}),
		);
	});

	it("names antigravity as the previous agent when it started the task", async () => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, card("antigravity"));
		const deps = dependencies();
		await handOffTask(deps, { taskId: "task-1", reason: "Reason" });
		expect(deps.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: expect.stringContaining("Another agent (antigravity) worked") }),
		);
	});

	it("lists opencode then antigravity before the second handoff", async () => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, { ...card("antigravity"), handOffCount: 1 });
		const deps = dependencies();
		await handOffTask(deps, { taskId: "task-1", reason: "Reason" });
		expect(deps.startTaskSession).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: expect.stringContaining("Other agents (opencode, then antigravity) worked"),
			}),
		);
	});

	it("visits three agents in two handoffs and refuses the third", async () => {
		const deps = dependencies();
		const visited = ["codex"];
		for (let i = 0; i < 2; i++) {
			const result = await handOffTask(deps, { taskId: "task-1", reason: "Reason" });
			expect(result.ok).toBe(true);
			if (result.ok) visited.push(result.toAgentId);
		}
		expect(visited).toEqual(["codex", "opencode", "antigravity"]);
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({
			ok: false,
			error: "Task has already been handed off twice",
		});
	});
});
