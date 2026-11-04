import { describe, expect, it } from "vitest";

import type { RuntimeBoardColumnId, RuntimeBoardData } from "../../src/core/api-contract";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	getReadyLinkedTaskIdsForTaskInTrash,
	moveTaskToColumn,
	trashTaskAndGetReadyLinkedTaskIds,
	updateTask,
} from "../../src/core/task-board-mutations";

function createBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

describe("deleteTasksFromBoard", () => {
	it("starts linked backlog tasks when a task is trashed from review", () => {
		const prerequisite = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "B", baseRef: "main" },
			() => "bbbbb111",
		);
		const dependent = addTaskToColumn(
			prerequisite.board,
			"review",
			{ prompt: "A", baseRef: "main" },
			() => "aaaaa111",
		);
		const linked = addTaskDependency(dependent.board, "bbbbb", "aaaaa");
		if (!linked.added) throw new Error("Expected dependency to be created.");

		expect(trashTaskAndGetReadyLinkedTaskIds(linked.board, "aaaaa").readyTaskIds).toEqual(["bbbbb"]);
	});

	it("does not start linked tasks when a task is trashed from in_progress", () => {
		const prerequisite = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "B", baseRef: "main" },
			() => "bbbbb111",
		);
		const dependent = addTaskToColumn(
			prerequisite.board,
			"in_progress",
			{ prompt: "A", baseRef: "main" },
			() => "aaaaa111",
		);
		const linked = addTaskDependency(dependent.board, "bbbbb", "aaaaa");
		if (!linked.added) throw new Error("Expected dependency to be created.");

		expect(trashTaskAndGetReadyLinkedTaskIds(linked.board, "aaaaa").readyTaskIds).toEqual([]);
	});

	it("removes a trashed task and any dependencies that reference it", () => {
		const createA = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task A", baseRef: "main" },
			() => "aaaaa111",
		);
		const createB = addTaskToColumn(createA.board, "review", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");
		const linked = addTaskDependency(createB.board, "aaaaa", "bbbbb");
		if (!linked.added) {
			throw new Error("Expected dependency to be created.");
		}
		const trashed = trashTaskAndGetReadyLinkedTaskIds(linked.board, "bbbbb");
		const deleted = deleteTasksFromBoard(trashed.board, ["bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds).toEqual(["bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
		expect(deleted.board.dependencies).toEqual([]);
	});

	it("removes multiple trashed tasks at once", () => {
		const createA = addTaskToColumn(createBoard(), "trash", { prompt: "Task A", baseRef: "main" }, () => "aaaaa111");
		const createB = addTaskToColumn(createA.board, "trash", { prompt: "Task B", baseRef: "main" }, () => "bbbbb111");

		const deleted = deleteTasksFromBoard(createB.board, ["aaaaa", "bbbbb"]);

		expect(deleted.deleted).toBe(true);
		expect(deleted.deletedTaskIds.sort()).toEqual(["aaaaa", "bbbbb"]);
		expect(deleted.board.columns.find((column) => column.id === "trash")?.cards).toEqual([]);
	});
});

describe("linked task readiness with several prerequisites", () => {
	function createLinkedBoard(columnByTaskId: Record<string, RuntimeBoardColumnId>): RuntimeBoardData {
		let board = createBoard();
		for (const [taskId, columnId] of Object.entries(columnByTaskId)) {
			board = addTaskToColumn(board, columnId, { prompt: taskId, baseRef: "main", taskId }, () => taskId).board;
		}
		return board;
	}

	function waitOn(board: RuntimeBoardData, fromTaskId: string, toTaskId: string): RuntimeBoardData {
		return {
			...board,
			dependencies: [...board.dependencies, { id: `${fromTaskId}-${toTaskId}`, fromTaskId, toTaskId, createdAt: 1 }],
		};
	}

	function createBoardWaitingOnTwo(columnOfC: RuntimeBoardColumnId): RuntimeBoardData {
		return waitOn(waitOn(createLinkedBoard({ A: "backlog", B: "review", C: columnOfC }), "A", "B"), "A", "C");
	}

	function createBoardWaitingOnDeletedTask(): RuntimeBoardData {
		return waitOn(waitOn(createLinkedBoard({ A: "backlog", B: "review" }), "A", "B"), "A", "deleted");
	}

	describe("trashTaskAndGetReadyLinkedTaskIds", () => {
		it("starts the waiting task only after its last prerequisite is trashed", () => {
			const trashedB = trashTaskAndGetReadyLinkedTaskIds(createBoardWaitingOnTwo("review"), "B");
			expect(trashedB.moved).toBe(true);
			expect(trashedB.readyTaskIds).toEqual([]);

			const trashedC = trashTaskAndGetReadyLinkedTaskIds(trashedB.board, "C");
			expect(trashedC.moved).toBe(true);
			expect(trashedC.readyTaskIds).toEqual(["A"]);
		});

		it("does not start the waiting task while another prerequisite is in progress", () => {
			const trashed = trashTaskAndGetReadyLinkedTaskIds(createBoardWaitingOnTwo("in_progress"), "B");
			expect(trashed.readyTaskIds).toEqual([]);
		});

		it("does not start the waiting task on a review pass while another prerequisite is unfinished", () => {
			const board = waitOn(
				waitOn(createLinkedBoard({ A: "backlog", B: "in_progress", C: "in_progress" }), "A", "B"),
				"A",
				"C",
			);
			expect(trashTaskAndGetReadyLinkedTaskIds(board, "B", 1, true).readyTaskIds).toEqual([]);
		});

		it("counts a prerequisite already in trash as finished", () => {
			expect(trashTaskAndGetReadyLinkedTaskIds(createBoardWaitingOnTwo("trash"), "B").readyTaskIds).toEqual(["A"]);
		});

		it("counts a prerequisite that no longer exists as finished", () => {
			expect(trashTaskAndGetReadyLinkedTaskIds(createBoardWaitingOnDeletedTask(), "B").readyTaskIds).toEqual(["A"]);
		});
	});

	describe("getReadyLinkedTaskIdsForTaskInTrash", () => {
		it("returns nothing while another prerequisite is unfinished", () => {
			expect(getReadyLinkedTaskIdsForTaskInTrash(createBoardWaitingOnTwo("review"), "B")).toEqual([]);
			expect(getReadyLinkedTaskIdsForTaskInTrash(createBoardWaitingOnTwo("in_progress"), "B")).toEqual([]);
		});

		it("returns the waiting task when the other prerequisite is already in trash", () => {
			expect(getReadyLinkedTaskIdsForTaskInTrash(createBoardWaitingOnTwo("trash"), "B")).toEqual(["A"]);
		});

		it("returns the waiting task for a single prerequisite", () => {
			const board = waitOn(createLinkedBoard({ A: "backlog", B: "review" }), "A", "B");
			expect(getReadyLinkedTaskIdsForTaskInTrash(board, "B")).toEqual(["A"]);
		});

		it("counts a prerequisite that no longer exists as finished", () => {
			expect(getReadyLinkedTaskIdsForTaskInTrash(createBoardWaitingOnDeletedTask(), "B")).toEqual(["A"]);
		});
	});
});

describe("task images", () => {
	it("preserves images when creating and updating tasks", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task with image",
				baseRef: "main",
				images: [
					{
						id: "img-1",
						data: "abc123",
						mimeType: "image/png",
					},
				],
			},
			() => "aaaaa111",
		);

		expect(created.task.images).toEqual([
			{
				id: "img-1",
				data: "abc123",
				mimeType: "image/png",
			},
		]);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task with updated image",
			baseRef: "main",
			images: [
				{
					id: "img-2",
					data: "def456",
					mimeType: "image/jpeg",
				},
			],
		});

		expect(updated.task?.images).toEqual([
			{
				id: "img-2",
				data: "def456",
				mimeType: "image/jpeg",
			},
		]);
	});
});

describe("per-task agent/model/provider overrides", () => {
	it("persists agentId on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Smart task", baseRef: "main", agentId: "claude" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("claude");
	});

	it("persists task-level Cline settings on the card when creating a task", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Dumb task",
				baseRef: "main",
				agentId: "cline",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBe("cline");
		expect(created.task.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});

	it("leaves override fields undefined when not provided", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Default task", baseRef: "main" },
			() => "aaaaa111",
		);

		expect(created.task.agentId).toBeUndefined();
		expect(created.task.clineSettings).toBeUndefined();
	});

	it("updates agentId from undefined to a value", () => {
		const created = addTaskToColumn(createBoard(), "backlog", { prompt: "Task", baseRef: "main" }, () => "aaaaa111");
		expect(created.task.agentId).toBeUndefined();

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
		});

		expect(updated.updated).toBe(true);
		expect(updated.task?.agentId).toBe("codex");
	});

	it("updates clineModelId", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{ prompt: "Task", baseRef: "main", clineSettings: { modelId: "old-model" } },
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			clineSettings: { modelId: "new-model" },
		});

		expect(updated.task?.clineSettings?.modelId).toBe("new-model");
	});

	it("preserves existing overrides when update input omits them (undefined)", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "low",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Updated prompt",
			baseRef: "main",
			// agentId and clineSettings are undefined, so existing overrides should persist
		});

		expect(updated.task?.agentId).toBe("claude");
		expect(updated.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "low",
		});
	});

	it("clears overrides when update input provides null", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Task",
				baseRef: "main",
				agentId: "codex",
				clineSettings: {
					providerId: "openai",
					modelId: "gpt-4",
					reasoningEffort: "medium",
				},
			},
			() => "aaaaa111",
		);

		const updated = updateTask(created.board, created.task.id, {
			prompt: "Task",
			baseRef: "main",
			agentId: null,
			clineSettings: null,
		});

		expect(updated.task?.agentId).toBeUndefined();
		expect(updated.task?.clineSettings).toBeUndefined();
	});

	it("preserves overrides across move operations", () => {
		const created = addTaskToColumn(
			createBoard(),
			"backlog",
			{
				prompt: "Movable task",
				baseRef: "main",
				agentId: "claude",
				clineSettings: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4-20250514",
					reasoningEffort: "high",
				},
			},
			() => "aaaaa111",
		);

		const moved = moveTaskToColumn(created.board, created.task.id, "in_progress");

		expect(moved.moved).toBe(true);
		expect(moved.task?.agentId).toBe("claude");
		expect(moved.task?.clineSettings).toEqual({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-20250514",
			reasoningEffort: "high",
		});
	});
});

describe("blocked report clearing", () => {
	it("drops blockedReport when a task moves to trash but keeps it for other moves", () => {
		const added = addTaskToColumn(createBoard(), "review", { prompt: "A", baseRef: "main" }, () => "aaaaa111");
		const board: RuntimeBoardData = {
			...added.board,
			columns: added.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((card) => ({ ...card, blockedReport: { question: "A or B?", reportedAt: 1 } })),
			})),
		};

		const moved = moveTaskToColumn(board, "aaaaa", "in_progress");
		expect(moved.task?.blockedReport).toEqual({ question: "A or B?", reportedAt: 1 });
		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, "aaaaa");
		expect(trashed.task).not.toHaveProperty("blockedReport");
		const trashCards = trashed.board.columns.find((column) => column.id === "trash")?.cards ?? [];
		expect(trashCards[0]).not.toHaveProperty("blockedReport");
		expect(moveTaskToColumn(board, "aaaaa", "trash").task).not.toHaveProperty("blockedReport");
	});
});
