import { useCallback, useEffect, useSyncExternalStore } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeGithubIssuesResponse, RuntimeWorkspaceStateResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

type GithubIssuesByTaskId = RuntimeGithubIssuesResponse["issues"];
export type GithubIssueLink = GithubIssuesByTaskId[string];

const EMPTY_ISSUES: GithubIssuesByTaskId = {};
let issuesByTaskId: GithubIssuesByTaskId = EMPTY_ISSUES;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/**
 * Loads the GitHub issue links of the current project and refetches them on every
 * `workspace_state_updated` stream message. Issue data never lives on the board card.
 * Mount once (App); cards read it with `useGithubIssue`.
 */
export function useGithubIssues(
	workspaceId: string | null,
	streamedWorkspaceState: RuntimeWorkspaceStateResponse | null,
): void {
	const queryFn = useCallback(
		async () => await getRuntimeTrpcClient(workspaceId).workspace.getGithubIssues.query(),
		[workspaceId],
	);
	const { data, refetch } = useTrpcQuery({ enabled: workspaceId !== null, queryFn, retainDataOnError: true });

	useEffect(() => {
		if (streamedWorkspaceState) {
			void refetch();
		}
	}, [streamedWorkspaceState, refetch]);

	const issues = workspaceId !== null && data ? data.issues : EMPTY_ISSUES;
	useEffect(() => {
		issuesByTaskId = issues;
		for (const listener of listeners) {
			listener();
		}
	}, [issues]);
}

export function useGithubIssue(taskId: string): GithubIssueLink | null {
	return useSyncExternalStore(subscribe, () => issuesByTaskId[taskId] ?? null);
}
