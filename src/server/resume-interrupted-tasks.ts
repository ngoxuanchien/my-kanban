// Shutdown (or a crash) leaves cards in their columns and task worktrees on disk. On startup this
// relaunches the agent of every In Progress task in its worktree and continues its previous conversation.
import type { RuntimeBoardCard, RuntimeTaskSessionStartResponse } from "../core/api-contract";
import { listWorkspaceIndexEntries, loadWorkspaceState } from "../state/workspace-state";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { resolveTaskCwd } from "../workspace/task-worktree";

// Sent to every agent: some (OpenCode) resume without a prompt and then sit idle waiting for input.
export const RESUME_AFTER_RESTART_PROMPT = "Kanban was restarted; continue the task where you left off.";

type StartTaskSession = RuntimeTrpcContext["runtimeApi"]["startTaskSession"];

/** Relaunches the task agent in its existing worktree, continuing its previous conversation with `prompt`. */
export async function resumeTaskSession(
	startTaskSession: StartTaskSession,
	scope: RuntimeTrpcWorkspaceScope,
	card: RuntimeBoardCard,
	prompt: string,
): Promise<RuntimeTaskSessionStartResponse> {
	try {
		// Throws when the worktree is gone; never create a fresh one to "continue" in.
		await resolveTaskCwd({ cwd: scope.workspacePath, taskId: card.id, baseRef: card.baseRef, ensure: false });
	} catch (error) {
		return { ok: false, summary: null, error: error instanceof Error ? error.message : String(error) };
	}
	return await startTaskSession(scope, {
		taskId: card.id,
		prompt,
		taskTitle: card.title,
		baseRef: card.baseRef,
		agentId: card.agentId,
		clineSettings: card.clineSettings,
		resumeFromPersistence: true,
	});
}

export async function resumeInterruptedTasks(deps: {
	startTaskSession: StartTaskSession;
	warn: (message: string) => void;
}): Promise<void> {
	for (const { workspaceId, repoPath } of await listWorkspaceIndexEntries()) {
		try {
			const { board, sessions } = await loadWorkspaceState(repoPath);
			const cards = board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
			for (const card of cards) {
				// Persisted sessions can be stale or missing (a crash, or a task started from the CLI), so only
				// an agent that had clearly stopped on its own is left alone.
				const state = sessions[card.id]?.state;
				if (state === "idle" || state === "failed") {
					continue;
				}
				const resumed = await resumeTaskSession(
					deps.startTaskSession,
					{ workspaceId, workspacePath: repoPath },
					card,
					RESUME_AFTER_RESTART_PROMPT,
				);
				if (!resumed.ok) {
					deps.warn(`Could not resume task ${card.id} after restart: ${resumed.error ?? "unknown error"}`);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn(`Could not resume interrupted tasks for ${repoPath}: ${message}`);
		}
	}
}
