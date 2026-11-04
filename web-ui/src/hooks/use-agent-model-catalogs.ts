import { useCallback } from "react";

import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentModelCatalogsResponse } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

export interface UseAgentModelCatalogsResult {
	catalogs: RuntimeAgentModelCatalogsResponse | null;
	isLoading: boolean;
	refresh: () => void;
}

export function useAgentModelCatalogs(enabled: boolean, workspaceId: string | null): UseAgentModelCatalogsResult {
	const queryFn = useCallback(
		async () => await getRuntimeTrpcClient(workspaceId).runtime.getAgentModelCatalogs.query(),
		[workspaceId],
	);
	const query = useTrpcQuery<RuntimeAgentModelCatalogsResponse>({ enabled, queryFn, retainDataOnError: true });
	const setData = query.setData;
	const refresh = useCallback(() => {
		void getRuntimeTrpcClient(workspaceId)
			.runtime.getAgentModelCatalogs.query({ refresh: true })
			.then(setData)
			.catch(() => {});
	}, [setData, workspaceId]);
	return { catalogs: query.data, isLoading: query.isLoading, refresh };
}
