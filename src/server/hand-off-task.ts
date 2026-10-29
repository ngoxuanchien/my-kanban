import type { RuntimeAgentId, RuntimeBoardCard } from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";

export type HandOffAgentId = "codex" | "opencode";

export interface HandOffTaskDependencies {
	workspacePath: string;
	stopTaskSession: (taskId: string) => Promise<void>;
	startTaskSession: (input: {
		taskId: string;
		prompt: string;
		taskTitle: string;
		baseRef: string;
		agentId: HandOffAgentId;
	}) => Promise<{ ok: boolean; error?: string | null }>;
	broadcastStateUpdated: () => Promise<void> | void;
}

export type HandOffTaskResult =
	| { ok: true; taskId: string; fromAgentId: HandOffAgentId; toAgentId: HandOffAgentId }
	| { ok: false; error: string };

export function buildHandOffPrompt(input: {
	originalPrompt: string;
	fromAgentId: HandOffAgentId;
	baseRef: string;
	reason: string;
}): string {
	return `${input.originalPrompt}\n\n---\n[Kanban handoff] Another agent (${input.fromAgentId}) worked on this task before you and could not finish it.\nIts unfinished work is already in this worktree (uncommitted changes and commits since ${input.baseRef}). Check it and continue from it; do not start over.\nWhy it was handed off: ${input.reason}`;
}

function findCard(board: { columns: Array<{ cards: RuntimeBoardCard[] }> }, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) return card;
	}
	return null;
}

function isHandOffAgentId(agentId: RuntimeAgentId | undefined): agentId is HandOffAgentId {
	return agentId === "codex" || agentId === "opencode";
}

function refusal(card: RuntimeBoardCard | null): string | null {
	if (!card) return "Task not found";
	if (card.agentReviewEnabled !== true) return "Agent review is not enabled for this task";
	if (card.handedOff === true) return "Task has already been handed off";
	if (!isHandOffAgentId(card.agentId)) return "Task agent must be codex or opencode to hand off";
	return null;
}

export async function handOffTask(
	deps: HandOffTaskDependencies,
	input: { taskId: string; reason: string },
): Promise<HandOffTaskResult> {
	const state = await loadWorkspaceState(deps.workspacePath);
	const card = findCard(state.board, input.taskId);
	const initialRefusal = refusal(card);
	if (initialRefusal) return { ok: false, error: initialRefusal };
	if (!card || !isHandOffAgentId(card.agentId))
		return { ok: false, error: "Task agent must be codex or opencode to hand off" };

	const fromAgentId = card.agentId;
	const toAgentId: HandOffAgentId = fromAgentId === "codex" ? "opencode" : "codex";
	await deps.stopTaskSession(input.taskId);
	const mutation = await mutateWorkspaceState<HandOffTaskResult>(deps.workspacePath, (current) => {
		const currentCard = findCard(current.board, input.taskId);
		const currentRefusal = refusal(currentCard);
		if (currentRefusal || currentCard?.agentId !== fromAgentId) {
			return {
				board: current.board,
				value: { ok: false as const, error: currentRefusal ?? "Task agent changed before handoff" },
				save: false,
			};
		}
		const updatedBoard = {
			...current.board,
			columns: current.board.columns.map((column) => ({
				...column,
				cards: column.cards.map((candidate) =>
					candidate.id === input.taskId ? { ...candidate, agentId: toAgentId, handedOff: true } : candidate,
				),
			})),
		};
		return {
			board: moveTaskToColumn(updatedBoard, input.taskId, "in_progress").board,
			value: { ok: true, taskId: input.taskId, fromAgentId, toAgentId },
			save: true,
		};
	});
	if (!mutation.value.ok) return mutation.value;

	const started = await deps.startTaskSession({
		taskId: input.taskId,
		prompt: buildHandOffPrompt({
			originalPrompt: card.prompt,
			fromAgentId,
			baseRef: card.baseRef,
			reason: input.reason,
		}),
		taskTitle: card.title ?? card.prompt,
		baseRef: card.baseRef,
		agentId: toAgentId,
	});
	await deps.broadcastStateUpdated();
	if (!started.ok) return { ok: false, error: started.error || "Could not start handed-off task session" };
	return { ok: true, taskId: input.taskId, fromAgentId, toAgentId };
}
