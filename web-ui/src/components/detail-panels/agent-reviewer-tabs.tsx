import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { cn } from "@/components/ui/cn";
import type { RuntimeAgentReviewState } from "@/runtime/types";

type AgentReviewerTab = "agent" | "reviewer";

/** Switches between the task agent panel and the reviewer panel; jumps to the reviewer when a review starts. */
export function AgentReviewerTabs({
	agentPanel,
	reviewerPanel,
	state,
}: {
	agentPanel: ReactNode;
	reviewerPanel: ReactNode;
	state: RuntimeAgentReviewState;
}): React.ReactElement {
	const isReviewing = state.status === "reviewing";
	const [tab, setTab] = useState<AgentReviewerTab>(isReviewing ? "reviewer" : "agent");
	useEffect(() => {
		if (isReviewing) {
			setTab("reviewer");
		}
	}, [isReviewing, state.round]);

	const tabButton = (value: AgentReviewerTab, label: string) => (
		<button
			type="button"
			role="tab"
			aria-selected={tab === value}
			onClick={() => setTab(value)}
			className={cn(
				"cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary",
				tab === value && "border-accent text-text-primary",
			)}
		>
			{label}
		</button>
	);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div role="tablist" className="flex shrink-0 border-b border-border bg-surface-1">
				{tabButton("agent", "Task agent")}
				{tabButton("reviewer", isReviewing ? "Reviewer (live)" : "Reviewer")}
			</div>
			{/* The task terminal stays mounted so its session stays connected while hidden. */}
			<div className={cn("min-h-0 min-w-0 flex-1", tab === "agent" ? "flex" : "hidden")}>{agentPanel}</div>
			{tab === "reviewer" ? reviewerPanel : null}
		</div>
	);
}
