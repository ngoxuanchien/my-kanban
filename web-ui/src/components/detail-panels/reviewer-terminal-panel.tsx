import { useState } from "react";

import { formatElapsed, getReviewerRoundLabel } from "@/components/agent-review-activity-panel";
import { AgentTerminalPanel } from "@/components/detail-panels/agent-terminal-panel";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState, RuntimeTaskSessionSummary } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

/** The reviewer's terminal session id; mirrors AGENT_REVIEW_SESSION_KEY_PREFIX in src/agent-review/task-session-signals.ts. */
export function getReviewerSessionKey(taskId: string): string {
	return `agent-review:${taskId}`;
}

/** Live terminal of the reviewer agent's own TUI (same terminal as the task agent), with a run header. */
export function ReviewerTerminalPanel({
	taskId,
	workspaceId,
	state,
	log,
	summary,
	terminalBackgroundColor,
	cursorColor,
}: {
	taskId: string;
	workspaceId: string | null;
	state: RuntimeAgentReviewState;
	log: RuntimeAgentReviewLog | null;
	/** Summary of the reviewer's terminal session, so the terminal resets when a new run starts. */
	summary: RuntimeTaskSessionSummary | null;
	terminalBackgroundColor: string;
	cursorColor: string;
}): React.ReactElement {
	const isReviewing = state.status === "reviewing";
	// While reviewing, a finished log still belongs to the previous run until the next poll lands.
	const shownLog = isReviewing ? (log && log.round === state.round && log.finishedAt === null ? log : null) : log;
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), isReviewing ? 1000 : null);

	const agentLabel = shownLog?.reviewerAgentId ?? (isReviewing ? "starting…" : "no run yet");
	const round = shownLog?.round ?? state.round;
	const finishedAt = shownLog?.finishedAt ?? null;
	const placeholder = !shownLog
		? isReviewing
			? "Starting the reviewer…"
			: "No reviewer run yet."
		: shownLog.reviewerAgentId === "cline"
			? "The Cline reviewer runs inside Kanban, so there is no terminal to show."
			: null;

	return (
		<section aria-label="Reviewer output" className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-0">
			<header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-xs">
				{isReviewing ? <Spinner size={12} /> : null}
				<strong className="text-text-primary">Reviewer · {agentLabel}</strong>
				<span className="text-text-secondary">{getReviewerRoundLabel(round)}</span>
				{shownLog ? (
					<span className="font-mono text-text-secondary">
						{formatElapsed((finishedAt ?? now) - shownLog.startedAt)}
						{finishedAt === null ? "" : " · finished"}
					</span>
				) : null}
			</header>
			{placeholder ? (
				<p className="m-0 p-3 text-xs text-text-secondary">{placeholder}</p>
			) : (
				<AgentTerminalPanel
					taskId={getReviewerSessionKey(taskId)}
					workspaceId={workspaceId}
					summary={summary}
					showSessionToolbar={false}
					panelBackgroundColor="var(--color-surface-0)"
					terminalBackgroundColor={terminalBackgroundColor}
					cursorColor={cursorColor}
				/>
			)}
		</section>
	);
}
