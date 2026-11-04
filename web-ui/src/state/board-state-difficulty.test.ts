import { describe, expect, it } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import {
	addTaskToColumnWithResult,
	applyTaskDetailClineSettingsChange,
	applyTaskDetailClineSettingsSelection,
	disableTaskAutoReview,
	findCardSelection,
	normalizeBoardData,
	updateTask,
	updateTaskTitle,
} from "@/state/board-state";
import type { BoardData } from "@/types";

const FIELDS = { difficulty: 3, agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" } as const;

function createBoard(agentId: "codex" | "cline" = "codex"): { board: BoardData; taskId: string } {
	const { board, task } = addTaskToColumnWithResult(createInitialBoardData(), "backlog", {
		prompt: "Task",
		baseRef: "main",
		agentId,
		...FIELDS,
	});
	return { board, taskId: task.id };
}

function cardOf(board: BoardData, taskId: string) {
	return findCardSelection(board, taskId)?.card;
}

describe("board-state difficulty fields", () => {
	it("normalizeCard keeps valid fields", () => {
		const board = normalizeBoardData({
			columns: [{ id: "backlog", cards: [{ id: "task-1", prompt: "Task", baseRef: "main", ...FIELDS }] }],
			dependencies: [],
		});
		expect(board?.columns[0]?.cards[0]).toMatchObject(FIELDS);
	});

	it("normalizeCard drops invalid fields", () => {
		for (const difficulty of [0, 6, 2.5, "3"]) {
			const board = normalizeBoardData({
				columns: [
					{
						id: "backlog",
						cards: [
							{
								id: "task-1",
								prompt: "Task",
								baseRef: "main",
								difficulty,
								agentModel: " ",
								agentReasoningEffort: 1,
							},
						],
					},
				],
				dependencies: [],
			});
			const card = board?.columns[0]?.cards[0];
			expect(card?.difficulty).toBeUndefined();
			expect(card?.agentModel).toBeUndefined();
			expect(card?.agentReasoningEffort).toBeUndefined();
		}
	});

	it("addTaskToColumnWithResult keeps the fields on the task and the board", () => {
		const { board, taskId } = createBoard();
		expect(cardOf(board, taskId)).toMatchObject(FIELDS);
	});

	it("updateTask keeps the fields when the draft does not carry them", () => {
		const { board, taskId } = createBoard();
		const updated = updateTask(board, taskId, { prompt: "Edited", baseRef: "main", agentId: "codex" });
		expect(cardOf(updated.board, taskId)).toMatchObject({ prompt: "Edited", ...FIELDS });
	});

	it("updateTask sets new values and null clears them", () => {
		const { board, taskId } = createBoard();
		const changed = updateTask(board, taskId, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
			difficulty: 5,
			agentModel: "gpt-6-astra",
			agentReasoningEffort: "low",
		});
		expect(cardOf(changed.board, taskId)).toMatchObject({
			difficulty: 5,
			agentModel: "gpt-6-astra",
			agentReasoningEffort: "low",
		});
		const cleared = updateTask(changed.board, taskId, {
			prompt: "Task",
			baseRef: "main",
			agentId: "codex",
			difficulty: null,
			agentModel: null,
			agentReasoningEffort: null,
		});
		const card = cardOf(cleared.board, taskId);
		expect(card?.difficulty).toBeUndefined();
		expect(card?.agentModel).toBeUndefined();
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("updateTask clears model and effort but keeps difficulty when the agent changes", () => {
		const { board, taskId } = createBoard();
		const updated = updateTask(board, taskId, { prompt: "Task", baseRef: "main", agentId: "opencode" });
		const card = cardOf(updated.board, taskId);
		expect(card?.agentId).toBe("opencode");
		expect(card?.difficulty).toBe(3);
		expect(card?.agentModel).toBeUndefined();
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("updateTask takes a model chosen together with the agent change", () => {
		const { board, taskId } = createBoard();
		const updated = updateTask(board, taskId, {
			prompt: "Task",
			baseRef: "main",
			agentId: "opencode",
			agentModel: "zen/free",
		});
		const card = cardOf(updated.board, taskId);
		expect(card?.agentModel).toBe("zen/free");
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("updateTaskTitle keeps the fields", () => {
		const { board, taskId } = createBoard();
		const updated = updateTaskTitle(board, taskId, "New title");
		expect(cardOf(updated.board, taskId)).toMatchObject({ title: "New title", ...FIELDS });
	});

	it("applyTaskDetailClineSettingsSelection keeps the fields for the same agent", () => {
		const { board, taskId } = createBoard("cline");
		const updated = applyTaskDetailClineSettingsSelection(board, taskId, {
			agentId: "cline",
			clineSettings: { providerId: "cline" },
		});
		expect(updated.updated).toBe(true);
		expect(cardOf(updated.board, taskId)).toMatchObject(FIELDS);
	});

	it("applyTaskDetailClineSettingsSelection clears model and effort for another agent", () => {
		const { board, taskId } = createBoard("cline");
		const updated = applyTaskDetailClineSettingsSelection(board, taskId, { agentId: "codex", clineSettings: null });
		const card = cardOf(updated.board, taskId);
		expect(card?.difficulty).toBe(3);
		expect(card?.agentModel).toBeUndefined();
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("applyTaskDetailClineSettingsChange keeps the fields", () => {
		const { board, taskId } = createBoard("cline");
		const updated = applyTaskDetailClineSettingsChange(
			board,
			taskId,
			{ providerId: "cline", modelId: "model-a", reasoningEffort: "" },
			{},
		);
		expect(updated.updated).toBe(true);
		expect(cardOf(updated.board, taskId)).toMatchObject(FIELDS);
	});

	it("disableTaskAutoReview keeps the fields", () => {
		const { board, taskId } = createBoard();
		const updated = disableTaskAutoReview(board, taskId);
		expect(cardOf(updated.board, taskId)).toMatchObject({ autoReviewEnabled: false, ...FIELDS });
	});
});
