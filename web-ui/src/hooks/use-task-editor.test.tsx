import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type UseTaskEditorResult, useTaskEditor } from "@/hooks/use-task-editor";
import type { RuntimeAgentId, RuntimeTaskClineSettings } from "@/runtime/types";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";
import type { TaskDifficulty } from "../../../src/core/agent-model";

const setTaskIssueSummaryMock = vi.hoisted(() =>
	vi.fn(async (_input: { taskId: string; summary: string }) => ({ ok: true as const })),
);

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ workspace: { setTaskIssueSummary: { mutate: setTaskIssueSummaryMock } } }),
}));

function createTask(taskId: string, prompt: string, createdAt: number, overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: taskId,
		title: prompt,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function createBoard(tasks: BoardCard[] = []): BoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: tasks },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

interface HookSnapshot {
	board: BoardData;
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	newTaskImages: TaskImage[];
	newTaskBranchRef: string;
	newTaskAgentId: RuntimeAgentId | undefined;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	newTaskAgentReviewEnabled: boolean;
	editingTaskId: string | null;
	editTaskPrompt: string;
	editTaskStartInPlanMode: boolean;
	isEditTaskStartInPlanModeDisabled: boolean;
	handleOpenCreateTask: () => void;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	setNewTaskPrompt: (value: string) => void;
	setNewTaskImages: (value: TaskImage[]) => void;
	handleOpenEditTask: (task: BoardCard) => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	setEditTaskPrompt: (value: string) => void;
	setEditTaskAutoReviewEnabled: (value: boolean) => void;
	setEditTaskAutoReviewMode: (value: TaskAutoReviewMode) => void;
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	setNewTaskClineSettings: (value: RuntimeTaskClineSettings | undefined) => void;
	setNewTaskAgentReviewEnabled: (value: boolean) => void;
	newTaskDifficulty: TaskDifficulty | undefined;
	newTaskAgentModel: string | undefined;
	newTaskAgentReasoningEffort: string | undefined;
	setNewTaskDifficulty: (value: TaskDifficulty | undefined) => void;
	setNewTaskAgentModel: (value: string | undefined) => void;
	setNewTaskAgentReasoningEffort: (value: string | undefined) => void;
	setEditTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	setEditTaskDifficulty: (value: TaskDifficulty | undefined) => void;
	setEditTaskAgentModel: (value: string | undefined) => void;
}

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected a hook snapshot.");
	}
	return snapshot;
}

function HookHarness({
	initialBoard,
	onSnapshot,
	queueTaskStartAfterEdit,
}: {
	initialBoard: BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	queueTaskStartAfterEdit?: (taskId: string) => void;
}): null {
	const [board, setBoard] = useState<BoardData>(initialBoard);
	const [, setSelectedTaskId] = useState<string | null>(null);
	const editor = useTaskEditor({
		board,
		setBoard,
		currentProjectId: "project-1",
		createTaskBranchOptions: [{ value: "main", label: "main" }],
		defaultTaskBranchRef: "main",
		selectedAgentId: null,
		setSelectedTaskId,
		queueTaskStartAfterEdit,
	});

	useEffect(() => {
		onSnapshot({
			board,
			isInlineTaskCreateOpen: editor.isInlineTaskCreateOpen,
			newTaskPrompt: editor.newTaskPrompt,
			newTaskImages: editor.newTaskImages,
			newTaskBranchRef: editor.newTaskBranchRef,
			newTaskAgentId: editor.newTaskAgentId,
			newTaskClineSettings: editor.newTaskClineSettings,
			newTaskAgentReviewEnabled: editor.newTaskAgentReviewEnabled,
			editingTaskId: editor.editingTaskId,
			editTaskPrompt: editor.editTaskPrompt,
			editTaskStartInPlanMode: editor.editTaskStartInPlanMode,
			isEditTaskStartInPlanModeDisabled: editor.isEditTaskStartInPlanModeDisabled,
			handleOpenCreateTask: editor.handleOpenCreateTask,
			handleCreateTask: editor.handleCreateTask,
			handleCreateTasks: editor.handleCreateTasks,
			setNewTaskPrompt: editor.setNewTaskPrompt,
			setNewTaskImages: editor.setNewTaskImages,
			handleOpenEditTask: editor.handleOpenEditTask,
			handleSaveEditedTask: editor.handleSaveEditedTask,
			handleSaveAndStartEditedTask: editor.handleSaveAndStartEditedTask,
			setEditTaskPrompt: editor.setEditTaskPrompt,
			setEditTaskAutoReviewEnabled: editor.setEditTaskAutoReviewEnabled,
			setEditTaskAutoReviewMode: editor.setEditTaskAutoReviewMode,
			setNewTaskAgentId: editor.setNewTaskAgentId,
			setNewTaskClineSettings: editor.setNewTaskClineSettings,
			setNewTaskAgentReviewEnabled: editor.setNewTaskAgentReviewEnabled,
			newTaskDifficulty: editor.newTaskDifficulty,
			newTaskAgentModel: editor.newTaskAgentModel,
			newTaskAgentReasoningEffort: editor.newTaskAgentReasoningEffort,
			setNewTaskDifficulty: editor.setNewTaskDifficulty,
			setNewTaskAgentModel: editor.setNewTaskAgentModel,
			setNewTaskAgentReasoningEffort: editor.setNewTaskAgentReasoningEffort,
			setEditTaskAgentId: editor.setEditTaskAgentId,
			setEditTaskDifficulty: editor.setEditTaskDifficulty,
			setEditTaskAgentModel: editor.setEditTaskAgentModel,
		});
	}, [
		board,
		editor.handleCreateTask,
		editor.handleCreateTasks,
		editor.handleOpenCreateTask,
		editor.editTaskPrompt,
		editor.editTaskStartInPlanMode,
		editor.editingTaskId,
		editor.handleOpenEditTask,
		editor.handleSaveEditedTask,
		editor.handleSaveAndStartEditedTask,
		editor.newTaskDifficulty,
		editor.newTaskAgentModel,
		editor.newTaskAgentReasoningEffort,
		editor.isEditTaskStartInPlanModeDisabled,
		editor.isInlineTaskCreateOpen,
		editor.newTaskPrompt,
		editor.newTaskImages,
		editor.newTaskBranchRef,
		editor.newTaskAgentId,
		editor.newTaskAgentReviewEnabled,
		editor.newTaskClineSettings,
		editor.setEditTaskAutoReviewEnabled,
		editor.setEditTaskAutoReviewMode,
		editor.setEditTaskPrompt,
		editor.setNewTaskAgentReviewEnabled,
		editor.setNewTaskImages,
		editor.setNewTaskPrompt,
		onSnapshot,
	]);

	return null;
}

describe("useTaskEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		localStorage.clear();
	});

	it("returns the edited task id when saving a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		requireSnapshot(latestSnapshot);

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		let savedTaskId: string | null = null;
		await act(async () => {
			savedTaskId = latestSnapshot?.handleSaveEditedTask() ?? null;
		});

		expect(savedTaskId).toBe("task-1");
		expect(requireSnapshot(latestSnapshot).editingTaskId).toBeNull();
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("does not disable start in plan mode when auto review is enabled while editing", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const initialBoard = createBoard([
			createTask("task-1", "Initial prompt", 1, {
				startInPlanMode: true,
			}),
		]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskAutoReviewEnabled(true);
			latestSnapshot?.setEditTaskAutoReviewMode("commit");
		});

		expect(requireSnapshot(latestSnapshot).isEditTaskStartInPlanModeDisabled).toBe(false);
	});

	it("queues the saved task id when saving and starting an edited task", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const queueTaskStartAfterEdit = vi.fn();
		const initialBoard = createBoard([createTask("task-1", "Initial prompt", 1)]);

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					queueTaskStartAfterEdit={queueTaskStartAfterEdit}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		const initialSnapshot = requireSnapshot(latestSnapshot);
		const task = initialSnapshot.board.columns[0]?.cards[0];
		if (!task) {
			throw new Error("Expected a backlog task.");
		}

		await act(async () => {
			initialSnapshot.handleOpenEditTask(task);
		});

		await act(async () => {
			latestSnapshot?.setEditTaskPrompt("Updated prompt");
		});

		await act(async () => {
			latestSnapshot?.handleSaveAndStartEditedTask();
		});

		expect(queueTaskStartAfterEdit).toHaveBeenCalledWith("task-1");
		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.prompt).toBe("Updated prompt");
	});

	it("keeps the create dialog open when requested after creating a task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Create another task");
		});
		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "low",
			});
		});

		await act(async () => {});
		expect(requireSnapshot(latestSnapshot).newTaskPrompt).toBe("Create another task");
		expect(requireSnapshot(latestSnapshot).newTaskBranchRef).toBe("main");

		let createdTaskId: string | null = null;
		await act(async () => {
			createdTaskId = requireSnapshot(latestSnapshot).handleCreateTask({ keepDialogOpen: true });
		});

		const snapshot = requireSnapshot(latestSnapshot);
		expect(createdTaskId).toBeTruthy();
		expect(snapshot.isInlineTaskCreateOpen).toBe(true);
		expect(snapshot.newTaskPrompt).toBe("");
		expect(snapshot.newTaskBranchRef).toBe("main");
		expect(snapshot.newTaskAgentId).toBeUndefined();
		expect(snapshot.newTaskClineSettings).toBeUndefined();
		expect(snapshot.board.columns[0]?.cards.some((card) => card.prompt === "Create another task")).toBe(true);
	});
	it("copies attached images to each split task and clears the draft images", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			latestSnapshot?.setNewTaskImages([
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			]);
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = latestSnapshot?.handleCreateTasks(["First task", "Second task"]) ?? [];
		});

		expect(createdTaskIds).toHaveLength(2);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(2);
		expect(backlogCards.map((card) => card.images)).toEqual([
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
			[
				{
					id: "img-1",
					data: "abc123",
					mimeType: "image/png",
				},
			],
		]);
		expect(requireSnapshot(latestSnapshot).newTaskImages).toEqual([]);
	});

	it("persists reasoning-only task overrides when model/provider stay inherited", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Reasoning override only");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				reasoningEffort: "low",
			});
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const createdCard = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		expect(createdCard?.clineSettings).toEqual({
			reasoningEffort: "low",
		});
	});

	it("preserves per-task agent/model override fields on each split task", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskAgentId("codex");
			requireSnapshot(latestSnapshot).setNewTaskClineSettings({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		});

		let createdTaskIds: string[] = [];
		await act(async () => {
			createdTaskIds = requireSnapshot(latestSnapshot).handleCreateTasks(["Task A", "Task B", "Task C"]);
		});

		expect(createdTaskIds).toHaveLength(3);
		const backlogCards = requireSnapshot(latestSnapshot).board.columns[0]?.cards ?? [];
		expect(backlogCards).toHaveLength(3);
		for (const card of backlogCards) {
			expect(card.agentId).toBe("codex");
			expect(card.clineSettings).toEqual({
				providerId: "provider-abc",
				modelId: "model-xyz",
				reasoningEffort: "medium",
			});
		}
	});

	it("creates a task with agentReviewEnabled when the toggle is on", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Let the sidebar agent review this");
			requireSnapshot(latestSnapshot).setNewTaskAgentReviewEnabled(true);
		});

		expect(requireSnapshot(latestSnapshot).newTaskAgentReviewEnabled).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		const createdCard = requireSnapshot(latestSnapshot).board.columns[0]?.cards[0];
		expect(createdCard?.prompt).toBe("Let the sidebar agent review this");
		expect(createdCard?.agentReviewEnabled).toBe(true);
		expect(requireSnapshot(latestSnapshot).newTaskAgentReviewEnabled).toBe(true);
	});

	it("creates tasks with agent review on by default and resets the toggle on", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={createBoard()}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleOpenCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).newTaskAgentReviewEnabled).toBe(true);

		await act(async () => {
			requireSnapshot(latestSnapshot).setNewTaskPrompt("Plain task");
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).handleCreateTask();
		});

		expect(requireSnapshot(latestSnapshot).board.columns[0]?.cards[0]?.agentReviewEnabled).toBe(true);
		expect(requireSnapshot(latestSnapshot).newTaskAgentReviewEnabled).toBe(true);
	});

	async function renderHarness(initialBoard: BoardData): Promise<() => HookSnapshot> {
		let latestSnapshot: HookSnapshot | null = null;
		await act(async () => {
			root.render(
				<HookHarness
					initialBoard={initialBoard}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});
		return () => requireSnapshot(latestSnapshot);
	}

	it("stores difficulty, agent model, and effort on a created task and resets the draft", async () => {
		const snapshot = await renderHarness(createBoard());

		await act(async () => {
			snapshot().handleOpenCreateTask();
		});
		await act(async () => {
			snapshot().setNewTaskPrompt("Hard task");
			snapshot().setNewTaskDifficulty(3);
			snapshot().setNewTaskAgentId("codex");
			snapshot().setNewTaskAgentModel("gpt-6.1-sol");
			snapshot().setNewTaskAgentReasoningEffort("high");
		});
		await act(async () => {
			snapshot().handleCreateTask();
		});

		const card = snapshot().board.columns[0]?.cards[0];
		expect(card?.agentId).toBe("codex");
		expect(card?.difficulty).toBe(3);
		expect(card?.agentModel).toBe("gpt-6.1-sol");
		expect(card?.agentReasoningEffort).toBe("high");
		expect(snapshot().newTaskDifficulty).toBeUndefined();
		expect(snapshot().newTaskAgentModel).toBeUndefined();
		expect(snapshot().newTaskAgentReasoningEffort).toBeUndefined();
	});

	it("stores difficulty and agent model on every split task", async () => {
		const snapshot = await renderHarness(createBoard());

		await act(async () => {
			snapshot().handleOpenCreateTask();
		});
		await act(async () => {
			snapshot().setNewTaskDifficulty(2);
			snapshot().setNewTaskAgentId("codex");
			snapshot().setNewTaskAgentModel("gpt-6.1-sol");
		});
		await act(async () => {
			snapshot().handleCreateTasks(["Task A", "Task B"]);
		});

		const cards = snapshot().board.columns[0]?.cards ?? [];
		expect(cards.map((card) => [card.difficulty, card.agentModel])).toEqual([
			[2, "gpt-6.1-sol"],
			[2, "gpt-6.1-sol"],
		]);
	});

	it("drops the draft model and effort when the agent changes while creating", async () => {
		const snapshot = await renderHarness(createBoard());

		await act(async () => {
			snapshot().handleOpenCreateTask();
		});
		await act(async () => {
			snapshot().setNewTaskPrompt("Switched agent");
			snapshot().setNewTaskDifficulty(4);
			snapshot().setNewTaskAgentId("codex");
			snapshot().setNewTaskAgentModel("gpt-6.1-sol");
			snapshot().setNewTaskAgentReasoningEffort("high");
		});
		await act(async () => {
			snapshot().setNewTaskAgentId("opencode");
		});
		await act(async () => {
			snapshot().handleCreateTask();
		});

		const card = snapshot().board.columns[0]?.cards[0];
		expect(card?.difficulty).toBe(4);
		expect(card?.agentModel).toBeUndefined();
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("saves a changed difficulty and clears the agent model when the agent changes", async () => {
		const task = createTask("task-1", "Prompt", 1, {
			agentId: "codex",
			difficulty: 2,
			agentModel: "gpt-6.1-sol",
			agentReasoningEffort: "high",
		});
		const snapshot = await renderHarness(createBoard([task]));

		await act(async () => {
			snapshot().handleOpenEditTask(task);
		});
		await act(async () => {
			snapshot().setEditTaskDifficulty(4);
			snapshot().setEditTaskAgentId("opencode");
		});
		await act(async () => {
			snapshot().handleSaveEditedTask();
		});

		const card = snapshot().board.columns[0]?.cards[0];
		expect(card?.agentId).toBe("opencode");
		expect(card?.difficulty).toBe(4);
		expect(card?.agentModel).toBeUndefined();
		expect(card?.agentReasoningEffort).toBeUndefined();
	});

	it("keeps the card's fields on an untouched edit and clears them when set back to auto", async () => {
		const task = createTask("task-1", "Prompt", 1, {
			agentId: "codex",
			difficulty: 2,
			agentModel: "gpt-6.1-sol",
			agentReasoningEffort: "high",
		});
		const snapshot = await renderHarness(createBoard([task]));

		await act(async () => {
			snapshot().handleOpenEditTask(task);
		});
		await act(async () => {
			snapshot().handleSaveEditedTask();
		});

		const kept = snapshot().board.columns[0]?.cards[0];
		expect(kept?.difficulty).toBe(2);
		expect(kept?.agentModel).toBe("gpt-6.1-sol");
		expect(kept?.agentReasoningEffort).toBe("high");

		await act(async () => {
			snapshot().handleOpenEditTask(task);
		});
		await act(async () => {
			snapshot().setEditTaskDifficulty(undefined);
			snapshot().setEditTaskAgentModel(undefined);
		});
		await act(async () => {
			snapshot().handleSaveEditedTask();
		});

		const cleared = snapshot().board.columns[0]?.cards[0];
		expect(cleared?.difficulty).toBeUndefined();
		expect(cleared?.agentModel).toBeUndefined();
		expect(cleared?.agentReasoningEffort).toBe("high");
	});
});

describe("useTaskEditor issue summary", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latest: { editor: UseTaskEditorResult; board: BoardData } | null = null;

	function SummaryHarness({ githubIssueSyncEnabled }: { githubIssueSyncEnabled: boolean }): null {
		const [board, setBoard] = useState<BoardData>(createBoard());
		const [, setSelectedTaskId] = useState<string | null>(null);
		const editor = useTaskEditor({
			board,
			setBoard,
			currentProjectId: "project-1",
			createTaskBranchOptions: [{ value: "main", label: "main" }],
			defaultTaskBranchRef: "main",
			selectedAgentId: null,
			setSelectedTaskId,
			githubIssueSyncEnabled,
		});
		latest = { editor, board };
		return null;
	}

	function current(): { editor: UseTaskEditorResult; board: BoardData } {
		if (!latest) {
			throw new Error("Expected the harness to render.");
		}
		return latest;
	}

	async function createWithSummary(githubIssueSyncEnabled: boolean, summary: string): Promise<string | null> {
		await act(async () => {
			root.render(<SummaryHarness githubIssueSyncEnabled={githubIssueSyncEnabled} />);
		});
		await act(async () => {
			current().editor.setNewTaskPrompt("Fix the login bug");
			current().editor.setNewTaskIssueSummary(summary);
		});
		let taskId: string | null = null;
		await act(async () => {
			taskId = current().editor.handleCreateTask();
		});
		return taskId;
	}

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		setTaskIssueSummaryMock.mockClear();
		latest = null;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("stores the summary under the new card id, and the board save waits for it", async () => {
		let resolveWrite: () => void = () => {};
		setTaskIssueSummaryMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveWrite = () => resolve({ ok: true });
				}),
		);
		const taskId = await createWithSummary(true, "  Users cannot log in.  ");

		expect(taskId).not.toBeNull();
		expect(current().board.columns[0]?.cards[0]?.id).toBe(taskId);
		expect(setTaskIssueSummaryMock).toHaveBeenCalledWith({ taskId, summary: "Users cannot log in." });
		expect(current().editor.newTaskIssueSummary).toBe("");

		let saveMayRun = false;
		const waiting = current()
			.editor.waitForIssueSummaryWrites()
			.then(() => {
				saveMayRun = true;
			});
		await Promise.resolve();
		expect(saveMayRun).toBe(false);
		resolveWrite();
		await waiting;
		expect(saveMayRun).toBe(true);
	});

	it("does not store an empty summary", async () => {
		await createWithSummary(true, "   ");
		expect(setTaskIssueSummaryMock).not.toHaveBeenCalled();
	});

	it("does not store a summary when sync is off", async () => {
		await createWithSummary(false, "Users cannot log in.");
		expect(setTaskIssueSummaryMock).not.toHaveBeenCalled();
	});
});
