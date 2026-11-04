import type { GithubIssueSyncService } from "./issue-sync";

export const GITHUB_ISSUE_POLL_INTERVAL_MS = 60_000;

// Each tick asks the sync service to reconcile every registered workspace. The reconcile itself
// returns before any `gh` call when the project did not opt in, so sync-off projects cost one config read.
export function startGithubIssuePolling(input: {
	sync: Pick<GithubIssueSyncService, "requestSync">;
	listWorkspaces: () => Promise<{ workspaceId: string; repoPath: string }[]>;
	intervalMs?: number;
}): () => void {
	const timer = setInterval(() => {
		void input.listWorkspaces().then(
			(workspaces) => {
				for (const { workspaceId, repoPath } of workspaces)
					input.sync.requestSync(workspaceId, repoPath, { pull: true });
			},
			() => undefined,
		);
	}, input.intervalMs ?? GITHUB_ISSUE_POLL_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
