import * as RadixPopover from "@radix-ui/react-popover";
import { useCallback } from "react";

import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeAgentScore, RuntimeEmployeeProfile } from "@/runtime/types";
import { useTrpcQuery } from "@/runtime/use-trpc-query";

function EmployeeProfileContent({ workspaceId, employeeKey }: { workspaceId: string; employeeKey: string }) {
	const queryFn = useCallback(
		async () => await getRuntimeTrpcClient(workspaceId).workspace.getEmployeeProfile.query({ key: employeeKey }),
		[workspaceId, employeeKey],
	);
	const { data, isLoading } = useTrpcQuery<RuntimeEmployeeProfile | null>({ enabled: true, queryFn });

	if (!data) {
		return isLoading ? <Spinner size={14} /> : <span className="text-text-secondary">No profile data</span>;
	}
	const topAreas = Object.entries(data.areas)
		.sort(([, a], [, b]) => b.passes + b.fails - (a.passes + a.fails))
		.slice(0, 3);
	return (
		<div className="flex flex-col gap-1">
			<div>
				<span className="text-text-primary">{data.key}</span>{" "}
				<span className="text-text-secondary">{data.status}</span>
			</div>
			{topAreas.length > 0 ? (
				<div className="text-text-secondary">
					{topAreas.map(([area, { passes, fails }]) => `${area} ${passes}/${fails}`).join(" · ")}
				</div>
			) : null}
			{data.strong.length > 0 ? (
				<div className="text-status-green">{data.strong.map((area) => `+${area}`).join(" ")}</div>
			) : null}
			{data.avoid.length > 0 ? (
				<div className="text-status-red">{data.avoid.map((area) => `-${area}`).join(" ")}</div>
			) : null}
			{data.notes ? <div className="line-clamp-2 text-text-secondary">{data.notes}</div> : null}
			<div className="text-text-tertiary">Edit: kanban employee set --employee {data.key}</div>
		</div>
	);
}

export function AgentScoreBar({
	agentScores,
	workspaceId = null,
}: {
	agentScores?: RuntimeAgentScore[];
	workspaceId?: string | null;
}): React.ReactElement | null {
	if (!agentScores || agentScores.length === 0) {
		return null;
	}

	return (
		<div
			className="hidden md:flex h-6 shrink-0 items-center whitespace-nowrap border-t border-border bg-surface-1 px-3 text-xs"
			data-testid="agent-score-strip"
		>
			{agentScores.map((agent, index) => (
				<span key={agent.agentId}>
					{index > 0 ? <span className="text-text-secondary"> · </span> : null}
					<RadixPopover.Root>
						<Tooltip content={`${agent.passes} pass · ${agent.fails} fail · ${agent.tasks} task`}>
							<RadixPopover.Trigger asChild>
								<button type="button" className="cursor-pointer">
									<span className="text-text-secondary">{agent.agentId}</span>{" "}
									<span
										className={
											agent.score > 0
												? "text-status-green"
												: agent.score < 0
													? "text-status-red"
													: "text-text-secondary"
										}
									>
										{agent.score > 0
											? `+${agent.score}`
											: agent.score < 0
												? `−${Math.abs(agent.score)}`
												: "0"}
									</span>{" "}
									<span className="text-text-secondary">
										({agent.tasks} {agent.tasks === 1 ? "task" : "tasks"})
									</span>
								</button>
							</RadixPopover.Trigger>
						</Tooltip>
						{workspaceId ? (
							<RadixPopover.Portal>
								<RadixPopover.Content
									side="top"
									align="start"
									sideOffset={6}
									className="z-50 max-w-72 whitespace-normal rounded-md border border-border bg-surface-1 p-2 text-xs shadow-lg"
								>
									<EmployeeProfileContent
										workspaceId={workspaceId}
										employeeKey={agent.agentId === "claude" ? "opus" : agent.agentId}
									/>
								</RadixPopover.Content>
							</RadixPopover.Portal>
						) : null}
					</RadixPopover.Root>
				</span>
			))}
		</div>
	);
}
