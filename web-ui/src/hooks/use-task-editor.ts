import { deriveTaskTitleFromPrompt } from "@runtime-task-title";
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { notifyError } from "@/components/app-toaster";
import {
	normalizeStoredTaskAutoReviewMode,
	TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
	TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
	TASK_START_IN_PLAN_MODE_STORAGE_KEY,
} from "@/hooks/app-utils";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentId, RuntimeClaudeModel, RuntimeTaskClineSettings } from "@/runtime/types";
import { addTaskToColumnWithResult, findCardSelection, updateTask, updateTaskTitle } from "@/state/board-state";
import { toTelemetrySelectedAgentId, trackTaskCreated } from "@/telemetry/events";
import type { BoardCard, BoardData, TaskAutoReviewMode, TaskImage } from "@/types";
import { resolveTaskAutoReviewMode } from "@/types";
import { useBooleanLocalStorageValue, useRawLocalStorageValue } from "@/utils/react-use";
import type { TaskDifficulty } from "../../../src/core/agent-model";

interface UseTaskEditorInput {
	board: BoardData;
	setBoard: Dispatch<SetStateAction<BoardData>>;
	currentProjectId: string | null;
	createTaskBranchOptions: Array<{ value: string; label: string }>;
	defaultTaskBranchRef: string;
	selectedAgentId: RuntimeAgentId | null;
	setSelectedTaskId: Dispatch<SetStateAction<string | null>>;
	queueTaskStartAfterEdit?: (taskId: string) => void;
	/** When true, a non-empty `newTaskIssueSummary` is stored for the created task. */
	githubIssueSyncEnabled?: boolean;
}

interface OpenEditTaskOptions {
	preserveDetailSelection?: boolean;
}

interface CreateTaskOptions {
	keepDialogOpen?: boolean;
}

export interface UseTaskEditorResult {
	isInlineTaskCreateOpen: boolean;
	newTaskPrompt: string;
	setNewTaskPrompt: Dispatch<SetStateAction<string>>;
	newTaskImages: TaskImage[];
	setNewTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	newTaskStartInPlanMode: boolean;
	setNewTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewEnabled: boolean;
	setNewTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	newTaskAutoReviewMode: TaskAutoReviewMode;
	setNewTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	newTaskAgentReviewEnabled: boolean;
	setNewTaskAgentReviewEnabled: Dispatch<SetStateAction<boolean>>;
	isNewTaskStartInPlanModeDisabled: boolean;
	newTaskBranchRef: string;
	setNewTaskBranchRef: Dispatch<SetStateAction<string>>;
	newTaskAgentId: RuntimeAgentId | undefined;
	/** Also clears the explicit model and effort: they belong to the previous agent. */
	setNewTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	newTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setNewTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	newTaskClaudeModel: RuntimeClaudeModel | undefined;
	setNewTaskClaudeModel: Dispatch<SetStateAction<RuntimeClaudeModel | undefined>>;
	newTaskIssueSummary: string;
	setNewTaskIssueSummary: Dispatch<SetStateAction<string>>;
	newTaskDifficulty: TaskDifficulty | undefined;
	setNewTaskDifficulty: Dispatch<SetStateAction<TaskDifficulty | undefined>>;
	newTaskAgentModel: string | undefined;
	setNewTaskAgentModel: Dispatch<SetStateAction<string | undefined>>;
	newTaskAgentReasoningEffort: string | undefined;
	setNewTaskAgentReasoningEffort: Dispatch<SetStateAction<string | undefined>>;
	editingTaskId: string | null;
	editTaskPrompt: string;
	setEditTaskPrompt: Dispatch<SetStateAction<string>>;
	editTaskImages: TaskImage[];
	setEditTaskImages: Dispatch<SetStateAction<TaskImage[]>>;
	editTaskStartInPlanMode: boolean;
	setEditTaskStartInPlanMode: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewEnabled: boolean;
	setEditTaskAutoReviewEnabled: Dispatch<SetStateAction<boolean>>;
	editTaskAutoReviewMode: TaskAutoReviewMode;
	setEditTaskAutoReviewMode: Dispatch<SetStateAction<TaskAutoReviewMode>>;
	editTaskAgentReviewEnabled: boolean;
	setEditTaskAgentReviewEnabled: Dispatch<SetStateAction<boolean>>;
	isEditTaskStartInPlanModeDisabled: boolean;
	editTaskBranchRef: string;
	setEditTaskBranchRef: Dispatch<SetStateAction<string>>;
	editTaskAgentId: RuntimeAgentId | undefined;
	/** Also clears the explicit model and effort: they belong to the previous agent. */
	setEditTaskAgentId: (value: RuntimeAgentId | undefined) => void;
	editTaskClineSettings: RuntimeTaskClineSettings | undefined;
	setEditTaskClineSettings: Dispatch<SetStateAction<RuntimeTaskClineSettings | undefined>>;
	editTaskClaudeModel: RuntimeClaudeModel | undefined;
	setEditTaskClaudeModel: Dispatch<SetStateAction<RuntimeClaudeModel | undefined>>;
	editTaskDifficulty: TaskDifficulty | undefined;
	setEditTaskDifficulty: Dispatch<SetStateAction<TaskDifficulty | undefined>>;
	editTaskAgentModel: string | undefined;
	setEditTaskAgentModel: Dispatch<SetStateAction<string | undefined>>;
	editTaskAgentReasoningEffort: string | undefined;
	setEditTaskAgentReasoningEffort: Dispatch<SetStateAction<string | undefined>>;
	handleOpenCreateTask: () => void;
	handleCancelCreateTask: () => void;
	handleOpenEditTask: (task: BoardCard, options?: OpenEditTaskOptions) => void;
	handleCancelEditTask: () => void;
	handleSaveEditedTask: () => string | null;
	handleSaveAndStartEditedTask: () => void;
	handleSaveTaskTitle: (taskId: string, title: string) => void;
	handleCreateTask: (options?: CreateTaskOptions) => string | null;
	handleCreateTasks: (prompts: string[], options?: CreateTaskOptions) => string[];
	resetTaskEditorState: () => void;
	/** Resolves once every issue summary sent for a created task is stored. Await before saving the board. */
	waitForIssueSummaryWrites: () => Promise<void>;
}

export function useTaskEditor({
	board,
	setBoard,
	currentProjectId,
	createTaskBranchOptions,
	defaultTaskBranchRef,
	selectedAgentId,
	setSelectedTaskId,
	queueTaskStartAfterEdit,
	githubIssueSyncEnabled = false,
}: UseTaskEditorInput): UseTaskEditorResult {
	const [isInlineTaskCreateOpen, setIsInlineTaskCreateOpen] = useState(false);
	const [newTaskPrompt, setNewTaskPrompt] = useState("");
	const [newTaskImages, setNewTaskImages] = useState<TaskImage[]>([]);
	const [newTaskStartInPlanMode, setNewTaskStartInPlanMode] = useBooleanLocalStorageValue(
		TASK_START_IN_PLAN_MODE_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewEnabled, setNewTaskAutoReviewEnabled] = useBooleanLocalStorageValue(
		TASK_AUTO_REVIEW_ENABLED_STORAGE_KEY,
		false,
	);
	const [newTaskAutoReviewMode, setNewTaskAutoReviewMode] = useRawLocalStorageValue<TaskAutoReviewMode>(
		TASK_AUTO_REVIEW_MODE_STORAGE_KEY,
		"commit",
		normalizeStoredTaskAutoReviewMode,
	);
	const isNewTaskStartInPlanModeDisabled = false;
	const [newTaskAgentReviewEnabled, setNewTaskAgentReviewEnabled] = useState(true);
	const [newTaskBranchRef, setNewTaskBranchRef] = useState("");
	const [lastCreatedTaskBranchByProjectId, setLastCreatedTaskBranchByProjectId] = useState<Record<string, string>>({});
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [editTaskPrompt, setEditTaskPrompt] = useState("");
	const [editTaskImages, setEditTaskImages] = useState<TaskImage[]>([]);
	const [editTaskStartInPlanMode, setEditTaskStartInPlanMode] = useState(false);
	const [editTaskAutoReviewEnabled, setEditTaskAutoReviewEnabled] = useState(false);
	const [editTaskAutoReviewMode, setEditTaskAutoReviewMode] = useState<TaskAutoReviewMode>("commit");
	const [editTaskAgentReviewEnabled, setEditTaskAgentReviewEnabled] = useState(false);
	const isEditTaskStartInPlanModeDisabled = false;
	const [editTaskBranchRef, setEditTaskBranchRef] = useState("");

	const [newTaskAgentId, setNewTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [newTaskClineSettings, setNewTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);
	const [newTaskClaudeModel, setNewTaskClaudeModel] = useState<RuntimeClaudeModel | undefined>(undefined);
	const [newTaskIssueSummary, setNewTaskIssueSummary] = useState("");
	const pendingIssueSummaryWritesRef = useRef<Promise<void>[]>([]);
	const [newTaskDifficulty, setNewTaskDifficulty] = useState<TaskDifficulty | undefined>(undefined);
	const [newTaskAgentModel, setNewTaskAgentModel] = useState<string | undefined>(undefined);
	const [newTaskAgentReasoningEffort, setNewTaskAgentReasoningEffort] = useState<string | undefined>(undefined);
	const [editTaskAgentId, setEditTaskAgentId] = useState<RuntimeAgentId | undefined>(undefined);
	const [editTaskClineSettings, setEditTaskClineSettings] = useState<RuntimeTaskClineSettings | undefined>(undefined);
	const [editTaskClaudeModel, setEditTaskClaudeModel] = useState<RuntimeClaudeModel | undefined>(undefined);
	const [editTaskDifficulty, setEditTaskDifficulty] = useState<TaskDifficulty | undefined>(undefined);
	const [editTaskAgentModel, setEditTaskAgentModel] = useState<string | undefined>(undefined);
	const [editTaskAgentReasoningEffort, setEditTaskAgentReasoningEffort] = useState<string | undefined>(undefined);

	const changeNewTaskAgentId = useCallback((value: RuntimeAgentId | undefined) => {
		setNewTaskAgentId(value);
		setNewTaskAgentModel(undefined);
		setNewTaskAgentReasoningEffort(undefined);
	}, []);
	const changeEditTaskAgentId = useCallback((value: RuntimeAgentId | undefined) => {
		setEditTaskAgentId(value);
		setEditTaskAgentModel(undefined);
		setEditTaskAgentReasoningEffort(undefined);
	}, []);

	const lastCreatedTaskBranchRef = useMemo(() => {
		if (!currentProjectId) {
			return null;
		}
		return lastCreatedTaskBranchByProjectId[currentProjectId] ?? null;
	}, [currentProjectId, lastCreatedTaskBranchByProjectId]);

	const resolvedDefaultTaskBranchRef = useMemo(() => {
		if (
			lastCreatedTaskBranchRef &&
			createTaskBranchOptions.some((option) => option.value === lastCreatedTaskBranchRef)
		) {
			return lastCreatedTaskBranchRef;
		}
		return defaultTaskBranchRef;
	}, [createTaskBranchOptions, defaultTaskBranchRef, lastCreatedTaskBranchRef]);

	useEffect(() => {
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === newTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isInlineTaskCreateOpen) {
			return;
		}
		if (!newTaskBranchRef) {
			setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		}
	}, [isInlineTaskCreateOpen, newTaskBranchRef, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!isNewTaskStartInPlanModeDisabled || !newTaskStartInPlanMode) {
			return;
		}
		setNewTaskStartInPlanMode(false);
	}, [isNewTaskStartInPlanModeDisabled, newTaskStartInPlanMode, setNewTaskStartInPlanMode]);

	useEffect(() => {
		if (!isEditTaskStartInPlanModeDisabled || !editTaskStartInPlanMode) {
			return;
		}
		setEditTaskStartInPlanMode(false);
	}, [editTaskStartInPlanMode, isEditTaskStartInPlanModeDisabled]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const isCurrentValid = createTaskBranchOptions.some((option) => option.value === editTaskBranchRef);
		if (isCurrentValid) {
			return;
		}
		setEditTaskBranchRef(resolvedDefaultTaskBranchRef);
	}, [createTaskBranchOptions, editTaskBranchRef, editingTaskId, resolvedDefaultTaskBranchRef]);

	useEffect(() => {
		if (!editingTaskId) {
			return;
		}
		const selection = findCardSelection(board, editingTaskId);
		if (!selection || selection.column.id !== "backlog") {
			setEditingTaskId(null);

			setEditTaskPrompt("");
			setEditTaskStartInPlanMode(false);
			setEditTaskAutoReviewEnabled(false);
			setEditTaskAgentReviewEnabled(false);
			setEditTaskAutoReviewMode("commit");
			setEditTaskImages([]);
			setEditTaskBranchRef("");
		}
	}, [board, editingTaskId]);

	const handleOpenCreateTask = useCallback(() => {
		setEditingTaskId(null);
		setEditTaskPrompt("");
		setEditTaskImages([]);

		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskClaudeModel(undefined);
		setNewTaskDifficulty(undefined);
		setNewTaskAgentModel(undefined);
		setNewTaskAgentReasoningEffort(undefined);
		setIsInlineTaskCreateOpen(true);
	}, []);

	const handleCancelCreateTask = useCallback(() => {
		setIsInlineTaskCreateOpen(false);

		setNewTaskPrompt("");
		setNewTaskImages([]);
		setNewTaskBranchRef(resolvedDefaultTaskBranchRef);
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskClaudeModel(undefined);
		setNewTaskDifficulty(undefined);
		setNewTaskAgentModel(undefined);
		setNewTaskAgentReasoningEffort(undefined);
	}, [resolvedDefaultTaskBranchRef]);

	const handleOpenEditTask = useCallback(
		(task: BoardCard, options?: OpenEditTaskOptions) => {
			if (!options?.preserveDetailSelection) {
				setSelectedTaskId(null);
			}
			setIsInlineTaskCreateOpen(false);

			setNewTaskPrompt("");
			setNewTaskImages([]);
			const taskPrompt = task.prompt.trim();
			setEditingTaskId(task.id);

			setEditTaskPrompt(taskPrompt);
			setEditTaskImages(task.images ? task.images.map((image) => ({ ...image })) : []);
			setEditTaskStartInPlanMode(task.startInPlanMode);
			setEditTaskAutoReviewEnabled(task.autoReviewEnabled === true);
			setEditTaskAgentReviewEnabled(task.agentReviewEnabled === true);
			setEditTaskAutoReviewMode(resolveTaskAutoReviewMode(task.autoReviewMode));
			const fallbackBranch = task.baseRef || resolvedDefaultTaskBranchRef;
			setEditTaskBranchRef(fallbackBranch);
			setEditTaskAgentId(task.agentId);
			setEditTaskClineSettings(task.clineSettings);
			setEditTaskClaudeModel(task.claudeModel);
			setEditTaskDifficulty(task.difficulty);
			setEditTaskAgentModel(task.agentModel);
			setEditTaskAgentReasoningEffort(task.agentReasoningEffort);
		},
		[resolvedDefaultTaskBranchRef, setSelectedTaskId],
	);

	const handleCancelEditTask = useCallback(() => {
		setEditingTaskId(null);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAgentReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskClaudeModel(undefined);
		setEditTaskDifficulty(undefined);
		setEditTaskAgentModel(undefined);
		setEditTaskAgentReasoningEffort(undefined);
	}, []);

	const handleSaveEditedTask = useCallback((): string | null => {
		if (!editingTaskId) {
			return null;
		}
		const prompt = editTaskPrompt.trim();
		if (!prompt) {
			return null;
		}
		if (!(editTaskBranchRef || resolvedDefaultTaskBranchRef)) {
			return null;
		}

		const baseRef = editTaskBranchRef || resolvedDefaultTaskBranchRef;
		const savedTaskId = editingTaskId;

		setBoard((currentBoard) => {
			const currentCard = currentBoard.columns.flatMap((c) => c.cards).find((c) => c.id === savedTaskId);
			const title = currentCard?.title ?? "";
			const updated = updateTask(currentBoard, savedTaskId, {
				title,
				prompt,
				startInPlanMode: editTaskStartInPlanMode,
				autoReviewEnabled: editTaskAutoReviewEnabled,
				autoReviewMode: editTaskAutoReviewMode,
				agentReviewEnabled: editTaskAgentReviewEnabled,
				images: editTaskImages,
				agentId: editTaskAgentId,
				clineSettings: editTaskClineSettings,
				claudeModel: editTaskClaudeModel,
				difficulty: editTaskDifficulty ?? null,
				agentModel: editTaskAgentModel ?? null,
				agentReasoningEffort: editTaskAgentReasoningEffort ?? null,
				baseRef,
			});
			return updated.updated ? updated.board : currentBoard;
		});
		setEditingTaskId(null);

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAgentReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskClaudeModel(undefined);
		setEditTaskDifficulty(undefined);
		setEditTaskAgentModel(undefined);
		setEditTaskAgentReasoningEffort(undefined);
		return savedTaskId;
	}, [
		editTaskAgentId,
		editTaskAgentReviewEnabled,
		editTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		editTaskBranchRef,
		editTaskClineSettings,
		editTaskClaudeModel,
		editTaskDifficulty,
		editTaskAgentModel,
		editTaskAgentReasoningEffort,
		editTaskPrompt,
		editTaskImages,
		editTaskStartInPlanMode,
		editingTaskId,
		resolvedDefaultTaskBranchRef,
		setBoard,
	]);

	const handleSaveAndStartEditedTask = useCallback(() => {
		const taskId = handleSaveEditedTask();
		if (!taskId) {
			return;
		}
		queueTaskStartAfterEdit?.(taskId);
	}, [handleSaveEditedTask, queueTaskStartAfterEdit]);

	const handleSaveTaskTitle = useCallback(
		(taskId: string, title: string) => {
			setBoard((currentBoard) => {
				const updated = updateTaskTitle(currentBoard, taskId, title);
				return updated.updated ? updated.board : currentBoard;
			});
		},
		[setBoard],
	);

	const handleCreateTask = useCallback(
		(options?: CreateTaskOptions): string | null => {
			const prompt = newTaskPrompt.trim();
			if (!prompt) {
				return null;
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return null;
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const title = deriveTaskTitleFromPrompt(prompt);
			const created = addTaskToColumnWithResult(board, "backlog", {
				title,
				prompt,
				startInPlanMode: newTaskStartInPlanMode,
				autoReviewEnabled: newTaskAutoReviewEnabled,
				autoReviewMode: newTaskAutoReviewMode,
				agentReviewEnabled: newTaskAgentReviewEnabled,
				images: newTaskImages,
				agentId: newTaskAgentId,
				clineSettings: newTaskClineSettings,
				claudeModel: newTaskClaudeModel,
				difficulty: newTaskDifficulty,
				agentModel: newTaskAgentModel,
				agentReasoningEffort: newTaskAgentReasoningEffort,
				baseRef,
			});
			const issueSummary = newTaskIssueSummary.trim();
			if (githubIssueSyncEnabled && issueSummary && currentProjectId) {
				// The board save waits for this write (waitForIssueSummaryWrites), so the issue is never
				// created without the summary the user typed.
				pendingIssueSummaryWritesRef.current.push(
					getRuntimeTrpcClient(currentProjectId)
						.workspace.setTaskIssueSummary.mutate({ taskId: created.task.id, summary: issueSummary })
						.then(
							() => undefined,
							(error: unknown) => notifyError(`Could not save the issue summary: ${String(error)}`),
						),
				);
			}
			setBoard(created.board);
			trackTaskCreated({
				selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
				start_in_plan_mode: newTaskStartInPlanMode,
				...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
				prompt_character_count: prompt.length,
			});
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}

			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskAgentReviewEnabled(true);
			setNewTaskBranchRef(baseRef);
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskClaudeModel(undefined);
			setNewTaskIssueSummary("");
			setNewTaskDifficulty(undefined);
			setNewTaskAgentModel(undefined);
			setNewTaskAgentReasoningEffort(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return created.task.id;
		},
		[
			board,
			currentProjectId,
			newTaskAgentId,
			newTaskAgentReviewEnabled,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskClaudeModel,
			newTaskDifficulty,
			newTaskAgentModel,
			newTaskAgentReasoningEffort,
			newTaskImages,
			newTaskIssueSummary,
			newTaskPrompt,
			newTaskStartInPlanMode,
			githubIssueSyncEnabled,
			resolvedDefaultTaskBranchRef,
			selectedAgentId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
			setNewTaskClaudeModel,
		],
	);

	const handleCreateTasks = useCallback(
		(prompts: string[], options?: CreateTaskOptions): string[] => {
			const validPrompts = prompts.map((p) => p.trim()).filter(Boolean);
			if (validPrompts.length === 0) {
				return [];
			}
			if (!(newTaskBranchRef || resolvedDefaultTaskBranchRef)) {
				return [];
			}
			const baseRef = newTaskBranchRef || resolvedDefaultTaskBranchRef;
			const createdTaskIds: string[] = [];
			let updatedBoard = board;
			for (const prompt of validPrompts) {
				const created = addTaskToColumnWithResult(updatedBoard, "backlog", {
					prompt,
					startInPlanMode: newTaskStartInPlanMode,
					autoReviewEnabled: newTaskAutoReviewEnabled,
					autoReviewMode: newTaskAutoReviewMode,
					agentReviewEnabled: newTaskAgentReviewEnabled,
					images: newTaskImages,
					agentId: newTaskAgentId,
					clineSettings: newTaskClineSettings,
					claudeModel: newTaskClaudeModel,
					difficulty: newTaskDifficulty,
					agentModel: newTaskAgentModel,
					agentReasoningEffort: newTaskAgentReasoningEffort,
					baseRef,
				});
				updatedBoard = created.board;
				createdTaskIds.push(created.task.id);
			}
			setBoard(updatedBoard);
			for (const prompt of validPrompts) {
				trackTaskCreated({
					selected_agent_id: toTelemetrySelectedAgentId(newTaskAgentId ?? selectedAgentId),
					start_in_plan_mode: newTaskStartInPlanMode,
					...(newTaskAutoReviewEnabled ? { auto_review_mode: newTaskAutoReviewMode } : {}),
					prompt_character_count: prompt.length,
				});
			}
			if (currentProjectId) {
				setLastCreatedTaskBranchByProjectId((current) => ({
					...current,
					[currentProjectId]: baseRef,
				}));
			}

			setNewTaskPrompt("");
			setNewTaskImages([]);
			setNewTaskAgentReviewEnabled(true);
			setNewTaskBranchRef(baseRef);
			setNewTaskAgentId(undefined);
			setNewTaskClineSettings(undefined);
			setNewTaskClaudeModel(undefined);
			setNewTaskDifficulty(undefined);
			setNewTaskAgentModel(undefined);
			setNewTaskAgentReasoningEffort(undefined);
			if (!options?.keepDialogOpen) {
				setIsInlineTaskCreateOpen(false);
			}
			return createdTaskIds;
		},
		[
			board,
			currentProjectId,
			newTaskAgentId,
			newTaskAgentReviewEnabled,
			newTaskAutoReviewEnabled,
			newTaskAutoReviewMode,
			newTaskBranchRef,
			newTaskClineSettings,
			newTaskClaudeModel,
			newTaskDifficulty,
			newTaskAgentModel,
			newTaskAgentReasoningEffort,
			newTaskImages,
			newTaskStartInPlanMode,
			resolvedDefaultTaskBranchRef,
			selectedAgentId,
			setBoard,
			setNewTaskAgentId,
			setNewTaskClineSettings,
			setNewTaskClaudeModel,
		],
	);

	const resetTaskEditorState = useCallback(() => {
		setIsInlineTaskCreateOpen(false);
		setEditingTaskId(null);

		setNewTaskPrompt("");

		setEditTaskPrompt("");
		setEditTaskStartInPlanMode(false);
		setEditTaskAutoReviewEnabled(false);
		setEditTaskAgentReviewEnabled(false);
		setEditTaskAutoReviewMode("commit");
		setEditTaskImages([]);
		setEditTaskBranchRef("");
		setEditTaskAgentId(undefined);
		setEditTaskClineSettings(undefined);
		setEditTaskClaudeModel(undefined);
		setEditTaskDifficulty(undefined);
		setEditTaskAgentModel(undefined);
		setEditTaskAgentReasoningEffort(undefined);
		setNewTaskImages([]);
		setNewTaskAgentReviewEnabled(true);
		setNewTaskAgentId(undefined);
		setNewTaskClineSettings(undefined);
		setNewTaskClaudeModel(undefined);
		setNewTaskIssueSummary("");
		setNewTaskDifficulty(undefined);
		setNewTaskAgentModel(undefined);
		setNewTaskAgentReasoningEffort(undefined);
	}, []);

	const waitForIssueSummaryWrites = useCallback(async () => {
		const pending = pendingIssueSummaryWritesRef.current;
		pendingIssueSummaryWritesRef.current = [];
		await Promise.all(pending);
	}, []);

	return {
		isInlineTaskCreateOpen,
		newTaskPrompt,
		setNewTaskPrompt,
		newTaskImages,
		setNewTaskImages,
		newTaskStartInPlanMode,
		setNewTaskStartInPlanMode,
		newTaskAutoReviewEnabled,
		setNewTaskAutoReviewEnabled,
		newTaskAutoReviewMode,
		setNewTaskAutoReviewMode,
		newTaskAgentReviewEnabled,
		setNewTaskAgentReviewEnabled,
		isNewTaskStartInPlanModeDisabled,
		newTaskBranchRef,
		setNewTaskBranchRef,
		newTaskAgentId,
		setNewTaskAgentId: changeNewTaskAgentId,
		newTaskClineSettings,
		setNewTaskClineSettings,
		newTaskClaudeModel,
		setNewTaskClaudeModel,
		newTaskIssueSummary,
		setNewTaskIssueSummary,
		newTaskDifficulty,
		setNewTaskDifficulty,
		newTaskAgentModel,
		setNewTaskAgentModel,
		newTaskAgentReasoningEffort,
		setNewTaskAgentReasoningEffort,
		editingTaskId,
		editTaskPrompt,
		setEditTaskPrompt,
		editTaskImages,
		setEditTaskImages,
		editTaskStartInPlanMode,
		setEditTaskStartInPlanMode,
		editTaskAutoReviewEnabled,
		setEditTaskAutoReviewEnabled,
		editTaskAutoReviewMode,
		setEditTaskAutoReviewMode,
		editTaskAgentReviewEnabled,
		setEditTaskAgentReviewEnabled,
		isEditTaskStartInPlanModeDisabled,
		editTaskBranchRef,
		setEditTaskBranchRef,
		editTaskAgentId,
		setEditTaskAgentId: changeEditTaskAgentId,
		editTaskClineSettings,
		setEditTaskClineSettings,
		editTaskClaudeModel,
		setEditTaskClaudeModel,
		editTaskDifficulty,
		setEditTaskDifficulty,
		editTaskAgentModel,
		setEditTaskAgentModel,
		editTaskAgentReasoningEffort,
		setEditTaskAgentReasoningEffort,
		handleOpenCreateTask,
		handleCancelCreateTask,
		handleOpenEditTask,
		handleCancelEditTask,
		handleSaveEditedTask,
		handleSaveAndStartEditedTask,
		handleSaveTaskTitle,
		handleCreateTask,
		handleCreateTasks,
		resetTaskEditorState,
		waitForIssueSummaryWrites,
	};
}
