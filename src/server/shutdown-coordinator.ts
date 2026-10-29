import { listWorkspaceIndexEntries } from "../state/workspace-state";
import { removeTaskWorktreeSetupLock } from "../workspace/task-worktree";
import type { WorkspaceRegistry } from "./workspace-registry";

export interface RuntimeShutdownCoordinatorDependencies {
	workspaceRegistry: Pick<WorkspaceRegistry, "listManagedWorkspaces">;
	warn: (message: string) => void;
	closeRuntimeServer: () => Promise<void>;
	skipSessionCleanup?: boolean;
}

async function cleanupTaskWorktreeSetupLocks(
	repoPaths: Iterable<string>,
	warn: (message: string) => void,
): Promise<void> {
	await Promise.all(
		Array.from(new Set(repoPaths)).map(async (repoPath) => {
			try {
				await removeTaskWorktreeSetupLock(repoPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				warn(`Could not remove task worktree setup lock for ${repoPath} during shutdown cleanup. ${message}`);
			}
		}),
	);
}

// Shutdown only stops processes. Cards keep their columns and task worktrees stay on disk (a crash
// leaves the same state), and the next startup resumes the work: see resume-interrupted-tasks.ts.
// Worktrees are deleted only when a task moves to Done.
export async function shutdownRuntimeServer(deps: RuntimeShutdownCoordinatorDependencies): Promise<void> {
	if (deps.skipSessionCleanup) {
		await deps.closeRuntimeServer();
		return;
	}

	const managedWorkspacePaths: string[] = [];
	for (const { workspacePath, terminalManager } of deps.workspaceRegistry.listManagedWorkspaces()) {
		terminalManager.markInterruptedAndStopAll();
		if (workspacePath) {
			managedWorkspacePaths.push(workspacePath);
		}
	}

	// Disposes Cline SDK sessions.
	await deps.closeRuntimeServer();

	const indexedWorkspaces = await listWorkspaceIndexEntries();
	await cleanupTaskWorktreeSetupLocks(
		[...managedWorkspacePaths, ...indexedWorkspaces.map((workspace) => workspace.repoPath)],
		deps.warn,
	);
}
