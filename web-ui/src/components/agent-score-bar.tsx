import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeAgentScore } from "@/runtime/types";

export function AgentScoreBar({ agentScores }: { agentScores?: RuntimeAgentScore[] }): React.ReactElement | null {
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
					<Tooltip content={`${agent.passes} pass · ${agent.fails} fail · ${agent.tasks} task`}>
						<span>
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
								{agent.score > 0 ? `+${agent.score}` : agent.score < 0 ? `−${Math.abs(agent.score)}` : "0"}
							</span>{" "}
							<span className="text-text-secondary">
								({agent.tasks} {agent.tasks === 1 ? "task" : "tasks"})
							</span>
						</span>
					</Tooltip>
				</span>
			))}
		</div>
	);
}
