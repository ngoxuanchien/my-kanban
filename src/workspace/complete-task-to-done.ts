import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { getTaskColumnId, trashTaskAndGetReadyLinkedTaskIds } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";

export interface CompleteTaskToDoneDeps {
	stopTaskSession(taskId: string): Promise<void>;
	startTask(taskId: string): Promise<unknown>;
	deleteTaskWorktree(taskId: string): Promise<{ removed: boolean; error?: string }>;
	notifyStateUpdated(): Promise<void>;
}

export interface CompleteTaskToDoneResult {
	previousColumnId: RuntimeBoardColumnId | null;
	alreadyInTrash: boolean;
	readyTaskIds: string[];
	autoStartedTasks: unknown[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	task: RuntimeBoardCard | null;
	// Workspace state as of the board write, so callers can format the task with its session.
	state: RuntimeWorkspaceStateResponse;
}

interface CompleteTaskToDoneMutationValue {
	previousColumnId: RuntimeBoardColumnId | null;
	task: RuntimeBoardCard | null;
	readyTaskIds: string[];
}

export function columnCanHaveLiveTaskSession(columnId: RuntimeBoardColumnId): boolean {
	return columnId === "in_progress" || columnId === "review";
}

function findCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

function replaceCard(board: RuntimeBoardData, nextCard: RuntimeBoardCard): RuntimeBoardData {
	return {
		...board,
		columns: board.columns.map((column) => ({
			...column,
			cards: column.cards.map((card) => (card.id === nextCard.id ? nextCard : card)),
		})),
	};
}

export async function completeTaskToDone(input: {
	repoPath: string;
	taskId: string;
	reviewPassed?: boolean;
	deps: CompleteTaskToDoneDeps;
	beforeMove?: (card: RuntimeBoardCard) => RuntimeBoardCard;
}): Promise<CompleteTaskToDoneResult> {
	const mutation = await mutateWorkspaceState<CompleteTaskToDoneMutationValue>(input.repoPath, (latestState) => {
		const previousColumnId = getTaskColumnId(latestState.board, input.taskId);
		const card = findCard(latestState.board, input.taskId);
		if (!previousColumnId || !card || previousColumnId === "trash") {
			return {
				board: latestState.board,
				value: { previousColumnId, task: card, readyTaskIds: [] },
				save: false,
			};
		}

		const board = input.beforeMove ? replaceCard(latestState.board, input.beforeMove(card)) : latestState.board;
		const trashed = trashTaskAndGetReadyLinkedTaskIds(board, input.taskId, Date.now(), input.reviewPassed);
		if (!trashed.moved || !trashed.task) {
			throw new Error(`Task "${input.taskId}" could not be moved to done.`);
		}
		return {
			board: trashed.board,
			value: { previousColumnId, task: trashed.task, readyTaskIds: trashed.readyTaskIds },
		};
	});

	const { previousColumnId, task, readyTaskIds } = mutation.value;
	if (!mutation.saved || !previousColumnId) {
		return {
			previousColumnId,
			alreadyInTrash: previousColumnId === "trash",
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeDeleted: false,
			task,
			state: mutation.state,
		};
	}

	await input.deps.notifyStateUpdated();

	if (columnCanHaveLiveTaskSession(previousColumnId)) {
		await input.deps.stopTaskSession(input.taskId);
	}

	const autoStartedTasks: unknown[] = [];
	for (const readyTaskId of readyTaskIds) {
		autoStartedTasks.push(await input.deps.startTask(readyTaskId));
	}

	const deletedWorktree = await input.deps.deleteTaskWorktree(input.taskId);

	return {
		previousColumnId,
		alreadyInTrash: false,
		readyTaskIds,
		autoStartedTasks,
		worktreeDeleted: deletedWorktree.removed,
		worktreeDeleteError: deletedWorktree.error,
		task,
		state: mutation.state,
	};
}
