// One AgentReviewService per workspace, created when a board has agent-review work and
// disposed with the workspace.
import { type AgentReviewService, createAgentReviewService } from "../agent-review/agent-review-service";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeBoardData } from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import {
	listWorkspaceIndexEntries,
	loadWorkspaceBoardById,
	loadWorkspaceState,
	mutateWorkspaceState,
} from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeTrpcContext, RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { columnCanHaveLiveTaskSession } from "../workspace/complete-task-to-done";
import { deleteTaskWorktree, resolveTaskCwd } from "../workspace/task-worktree";

export interface CreateAgentReviewRegistryDependencies {
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	getRuntimeApi: () => Pick<RuntimeTrpcContext["runtimeApi"], "startTaskSession" | "stopTaskSession">;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastRuntimeProjectsUpdated: (preferredCurrentProjectId: string | null) => Promise<void> | void;
	warn: (message: string) => void;
}

export interface AgentReviewRegistry {
	ensureAgentReviewServiceForWorkspace: (workspaceId: string, repoPath: string) => Promise<AgentReviewService>;
	/** Starts services for every registered workspace whose board has agent-review work. */
	startAgentReviewForRegisteredWorkspaces: () => Promise<void>;
	/** Call after a browser/CLI board save. */
	notifyBoardChanged: (workspaceId: string, repoPath: string) => Promise<void>;
	notifyUserInput: (workspaceId: string, taskId: string) => void;
	dispose: (workspaceId: string) => Promise<void>;
	disposeAll: () => Promise<void>;
}

function hasAgentReviewWork(board: RuntimeBoardData): boolean {
	return board.columns.some(
		(column) =>
			columnCanHaveLiveTaskSession(column.id) && column.cards.some((card) => card.agentReviewEnabled === true),
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createAgentReviewRegistry(deps: CreateAgentReviewRegistryDependencies): AgentReviewRegistry {
	const serviceByWorkspaceId = new Map<string, Promise<AgentReviewService>>();

	// Same steps as `kanban task start`, run in-process for tasks unblocked by an agent-review Done move.
	const startDependentTask = async (
		scope: RuntimeTrpcWorkspaceScope,
		taskId: string,
		broadcastStateUpdated: () => Promise<void>,
	) => {
		const { board } = await loadWorkspaceState(scope.workspacePath);
		const card = board.columns.flatMap((column) => column.cards).find((candidate) => candidate.id === taskId);
		if (!card) {
			return null;
		}
		const started = await deps.getRuntimeApi().startTaskSession(scope, {
			taskId,
			prompt: card.prompt,
			taskTitle: card.title,
			startInPlanMode: card.startInPlanMode,
			baseRef: card.baseRef,
			agentId: card.agentId,
			clineSettings: card.clineSettings,
		});
		if (!started.ok) {
			deps.warn(`[agent-review] Could not start dependent task ${taskId}: ${started.error ?? "unknown error"}`);
			return started;
		}
		const moved = await mutateWorkspaceState(scope.workspacePath, (state) => {
			const movement = moveTaskToColumn(state.board, taskId, "in_progress");
			return { board: movement.board, value: null, save: movement.moved };
		});
		if (moved.saved) {
			await broadcastStateUpdated();
		}
		return started;
	};

	const createService = async (workspaceId: string, repoPath: string): Promise<AgentReviewService> => {
		const scope: RuntimeTrpcWorkspaceScope = { workspaceId, workspacePath: repoPath };
		const broadcastStateUpdated = async () => {
			await deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, repoPath);
			await deps.broadcastRuntimeProjectsUpdated(workspaceId);
		};
		const service = createAgentReviewService({
			workspaceId,
			repoPath,
			terminalManager: await deps.ensureTerminalManagerForWorkspace(workspaceId, repoPath),
			clineService: await deps.getScopedClineTaskSessionService(scope),
			loadRuntimeConfig: async () => await deps.loadScopedRuntimeConfig(scope),
			resolveTaskCwd: async (taskId, baseRef) =>
				await resolveTaskCwd({ cwd: repoPath, taskId, baseRef, ensure: false }),
			doneDeps: {
				stopTaskSession: async (taskId) => {
					await deps.getRuntimeApi().stopTaskSession(scope, { taskId });
				},
				startTask: async (taskId) => await startDependentTask(scope, taskId, broadcastStateUpdated),
				deleteTaskWorktree: async (taskId) => {
					const deleted = await deleteTaskWorktree({ repoPath, taskId });
					return { removed: deleted.removed, error: deleted.ok ? undefined : deleted.error };
				},
				notifyStateUpdated: broadcastStateUpdated,
			},
			broadcastStateUpdated,
			warn: deps.warn,
		});
		await service.start();
		return service;
	};

	const ensureAgentReviewServiceForWorkspace = async (workspaceId: string, repoPath: string) => {
		let service = serviceByWorkspaceId.get(workspaceId);
		if (!service) {
			const created = createService(workspaceId, repoPath);
			service = created;
			serviceByWorkspaceId.set(workspaceId, created);
			created.catch(() => {
				if (serviceByWorkspaceId.get(workspaceId) === created) {
					serviceByWorkspaceId.delete(workspaceId);
				}
			});
		}
		return await service;
	};

	const dispose = async (workspaceId: string) => {
		const service = serviceByWorkspaceId.get(workspaceId);
		if (!service) {
			return;
		}
		serviceByWorkspaceId.delete(workspaceId);
		try {
			await (await service).dispose();
		} catch (error) {
			deps.warn(`[agent-review] Could not dispose agent review for ${workspaceId}: ${errorMessage(error)}`);
		}
	};

	return {
		ensureAgentReviewServiceForWorkspace,
		startAgentReviewForRegisteredWorkspaces: async () => {
			for (const { workspaceId, repoPath } of await listWorkspaceIndexEntries()) {
				try {
					if (hasAgentReviewWork(await loadWorkspaceBoardById(workspaceId))) {
						await ensureAgentReviewServiceForWorkspace(workspaceId, repoPath);
					}
				} catch (error) {
					deps.warn(`[agent-review] Could not start agent review for ${repoPath}: ${errorMessage(error)}`);
				}
			}
		},
		notifyBoardChanged: async (workspaceId, repoPath) => {
			try {
				const existing = serviceByWorkspaceId.get(workspaceId);
				if (existing) {
					await (await existing).notifyBoardChanged();
				} else if (hasAgentReviewWork((await loadWorkspaceState(repoPath)).board)) {
					await ensureAgentReviewServiceForWorkspace(workspaceId, repoPath);
				}
			} catch (error) {
				deps.warn(`[agent-review] Could not process board change for ${repoPath}: ${errorMessage(error)}`);
			}
		},
		notifyUserInput: (workspaceId, taskId) => {
			void serviceByWorkspaceId
				.get(workspaceId)
				?.then((service) => service.notifyUserInput(taskId))
				.catch(() => {});
		},
		dispose,
		disposeAll: async () => {
			await Promise.all([...serviceByWorkspaceId.keys()].map(dispose));
		},
	};
}
