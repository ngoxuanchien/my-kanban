import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";
import { useInterval } from "@/utils/react-use";

export const AGENT_REVIEW_LOG_POLL_INTERVAL_MS = 2000;

interface TaskReviewerLog {
	taskId: string;
	log: RuntimeAgentReviewLog | null;
}

/** Polls the reviewer run while the task is reviewing; fetches once per status change otherwise. */
export function useAgentReviewLog(
	workspaceId: string | null,
	taskId: string,
	state: RuntimeAgentReviewState | undefined,
): RuntimeAgentReviewLog | null {
	const enabled = workspaceId !== null && state !== undefined;
	const statusKey = `${state?.status ?? "none"}:${state?.round ?? 0}`;
	const queryFn = useCallback(async (): Promise<TaskReviewerLog> => {
		if (!workspaceId) {
			throw new Error("Missing workspace scope.");
		}
		// A new status or round re-runs the query so the final output shows up after a run ends.
		void statusKey;
		const response = await getRuntimeTrpcClient(workspaceId).workspace.getAgentReviewLog.query({ taskId });
		return { taskId, log: response.log };
	}, [statusKey, taskId, workspaceId]);
	const query = useTrpcQuery<TaskReviewerLog>({ enabled, queryFn, retainDataOnError: true });

	useInterval(
		() => {
			void query.refetch();
		},
		enabled && state?.status === "reviewing" ? AGENT_REVIEW_LOG_POLL_INTERVAL_MS : null,
	);

	return query.data?.taskId === taskId ? query.data.log : null;
}
