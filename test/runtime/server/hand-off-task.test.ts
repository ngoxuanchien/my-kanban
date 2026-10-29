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

vi.mock("../../../src/state/workspace-state", () => ({
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
	});

	it.each([
		["codex", "opencode"],
		["opencode", "codex"],
	] as const)("switches %s to %s and retains the existing review round", async (fromAgentId, toAgentId) => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, card(fromAgentId));
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
				fromAgentId,
				baseRef: "main",
				reason: "Fix the failing test",
			}),
			taskTitle: "Task one",
			baseRef: "main",
			agentId: toAgentId,
		});
		const moved = workspaceState.board.columns[1]?.cards[0];
		expect(moved).toMatchObject({ agentId: toAgentId, handedOff: true, reviewRound: 3 });
		expect(workspaceState.board.columns[2]?.cards).toHaveLength(0);
	});

	it("formats the handoff prompt exactly", () => {
		expect(
			buildHandOffPrompt({
				originalPrompt: "Original",
				fromAgentId: "codex",
				baseRef: "main",
				reason: "Tests fail",
			}),
		).toBe(
			"Original\n\n---\n[Kanban handoff] Another agent (codex) worked on this task before you and could not finish it.\n" +
				"Its unfinished work is already in this worktree (uncommitted changes and commits since main). Check it and continue from it; do not start over.\n" +
				"Why it was handed off: Tests fail",
		);
	});

	it.each([
		["already handed off", { ...card(), handedOff: true }, "Task has already been handed off"],
		["review disabled", { ...card(), agentReviewEnabled: false }, "Agent review is not enabled for this task"],
		["claude agent", card("claude"), "Task agent must be codex or opencode to hand off"],
		["unset agent", card(null), "Task agent must be codex or opencode to hand off"],
	])("refuses %s without changing the board", async (_label, refusedCard, error) => {
		workspaceState.board.columns[2]?.cards.splice(0, 1, refusedCard);
		const before = structuredClone(workspaceState.board);
		const deps = dependencies();
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({ ok: false, error });
		expect(workspaceState.board).toEqual(before);
		expect(deps.stopTaskSession).not.toHaveBeenCalled();
		expect(deps.startTaskSession).not.toHaveBeenCalled();
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

	it("returns a new-session error and keeps the card handed off", async () => {
		const deps = dependencies({ startTaskSession: vi.fn(async () => ({ ok: false, error: "x" })) });
		expect(await handOffTask(deps, { taskId: "task-1", reason: "Reason" })).toEqual({ ok: false, error: "x" });
		expect(workspaceState.board.columns[1]?.cards[0]).toMatchObject({ agentId: "opencode", handedOff: true });
		expect(deps.broadcastStateUpdated).toHaveBeenCalledOnce();
	});
});
