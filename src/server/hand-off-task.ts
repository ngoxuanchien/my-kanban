import type { RuntimeBoardCard } from "../core/api-contract";
import {
	getHandOffCount,
	type HandOffAgentId,
	handOffHistory,
	isHandOffAgentId,
	MAX_HAND_OFFS,
	nextHandOffAgent,
} from "../core/hand-off-cap";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";

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
	previousAgentIds: HandOffAgentId[];
	baseRef: string;
	reason: string;
}): string {
	const agents = input.previousAgentIds.join(", then ");
	const agentDescription =
		input.previousAgentIds.length > 1 ? `Other agents (${agents}) worked` : `Another agent (${agents}) worked`;
	return `${input.originalPrompt}\n\n---\n[Kanban handoff] ${agentDescription} on this task before you and could not finish it.\nIts unfinished work is already in this worktree (uncommitted changes and commits since ${input.baseRef}). Check it and continue from it; do not start over.\nWhy it was handed off: ${input.reason}`;
}

function findCard(board: { columns: Array<{ cards: RuntimeBoardCard[] }> }, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) return card;
	}
	return null;
}

function refusal(card: RuntimeBoardCard | null, quotaRetry = false): string | null {
	if (!card) return "Task not found";
	if (card.agentReviewEnabled !== true) return "Agent review is not enabled for this task";
	if (!quotaRetry && getHandOffCount(card) >= MAX_HAND_OFFS) return "Task has already been handed off twice";
	if (!isHandOffAgentId(card.agentId)) return "Task agent must be codex, opencode, or antigravity to hand off";
	return null;
}

export async function handOffTask(
	deps: HandOffTaskDependencies,
	input: { taskId: string; reason: string; quotaRetry?: boolean },
): Promise<HandOffTaskResult> {
	const state = await loadWorkspaceState(deps.workspacePath);
	const card = findCard(state.board, input.taskId);
	const initialRefusal = refusal(card, input.quotaRetry);
	if (initialRefusal) return { ok: false, error: initialRefusal };
	if (!card || !isHandOffAgentId(card.agentId))
		return { ok: false, error: "Task agent must be codex, opencode, or antigravity to hand off" };

	const fromAgentId = card.agentId;
	const handOffCount = getHandOffCount(card);
	const toAgentId = nextHandOffAgent(fromAgentId);
	await deps.stopTaskSession(input.taskId);
	const mutation = await mutateWorkspaceState<HandOffTaskResult>(deps.workspacePath, (current) => {
		const currentCard = findCard(current.board, input.taskId);
		const currentRefusal = refusal(currentCard, input.quotaRetry);
		if (currentRefusal || currentCard?.agentId !== fromAgentId || getHandOffCount(currentCard) !== handOffCount) {
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
				cards: column.cards.map((candidate) => {
					if (candidate.id !== input.taskId) return candidate;
					const { handedOff: _legacyHandedOff, quotaBlockedAt: _quotaBlockedAt, ...updatedCandidate } = candidate;
					return { ...updatedCandidate, agentId: toAgentId, handOffCount: getHandOffCount(candidate) + 1 };
				}),
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
			previousAgentIds: handOffHistory(fromAgentId, handOffCount),
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
