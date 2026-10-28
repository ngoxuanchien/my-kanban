import { useEffect, useRef, useState } from "react";

import { formatElapsed, getReviewerRoundLabel } from "@/components/agent-review-activity-panel";
import { Spinner } from "@/components/ui/spinner";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

// Within this many pixels of the bottom counts as "following" the output.
const FOLLOW_THRESHOLD_PX = 24;

/** Read-only, terminal-style view of the reviewer's output. Follows new output unless scrolled up. */
export function ReviewerTerminalPanel({
	state,
	log,
}: {
	state: RuntimeAgentReviewState;
	log: RuntimeAgentReviewLog | null;
}): React.ReactElement {
	const isReviewing = state.status === "reviewing";
	// While reviewing, a finished log still belongs to the previous run until the next poll lands.
	const shownLog = isReviewing ? (log && log.round === state.round && log.finishedAt === null ? log : null) : log;
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), isReviewing ? 1000 : null);

	const scrollRef = useRef<HTMLPreElement>(null);
	const followRef = useRef(true);
	useEffect(() => {
		const element = scrollRef.current;
		if (element && followRef.current) {
			element.scrollTop = element.scrollHeight;
		}
	}, [shownLog?.output]);

	const agentLabel = shownLog?.reviewerAgentId ?? (isReviewing ? "starting…" : "no run yet");
	const round = shownLog?.round ?? state.round;
	const finishedAt = shownLog?.finishedAt ?? null;

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
				<span className="text-text-tertiary">Read-only</span>
			</header>
			{shownLog?.truncated ? (
				<p className="m-0 shrink-0 px-3 pt-2 text-xs text-text-tertiary">Showing the end of the output.</p>
			) : null}
			<pre
				ref={scrollRef}
				onScroll={(event) => {
					const element = event.currentTarget;
					followRef.current =
						element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX;
				}}
				className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text-primary"
			>
				{shownLog?.output || (isReviewing ? "Waiting for reviewer output…" : "No reviewer output.")}
			</pre>
		</section>
	);
}
