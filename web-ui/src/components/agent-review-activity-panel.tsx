import { useEffect, useRef, useState } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";
import { useInterval } from "@/utils/react-use";

const MAX_FIX_ROUNDS = 3;

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ReviewerOutput({ log }: { log: RuntimeAgentReviewLog }): React.ReactElement {
	const preRef = useRef<HTMLPreElement>(null);
	useEffect(() => {
		const pre = preRef.current;
		if (pre) {
			pre.scrollTop = pre.scrollHeight;
		}
	}, [log.output]);
	return (
		<div className="space-y-1">
			{log.truncated ? <p className="m-0 text-xs text-text-tertiary">Showing the end of the output.</p> : null}
			<pre
				ref={preRef}
				className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-0 p-2 font-mono text-xs text-text-secondary"
			>
				{log.output || "No output yet."}
			</pre>
		</div>
	);
}

export function AgentReviewActivityPanel({
	state,
	log,
}: {
	state: RuntimeAgentReviewState;
	log: RuntimeAgentReviewLog | null;
}): React.ReactElement | null {
	const isReviewing = state.status === "reviewing";
	const [now, setNow] = useState(() => Date.now());
	useInterval(() => setNow(Date.now()), isReviewing ? 1000 : null);

	if (!isReviewing && !log && state.fixPrompts.length === 0) {
		return null;
	}
	// Until the next poll lands, the log can still belong to the previous run.
	const currentLog = log && log.round === state.round && log.finishedAt === null ? log : null;
	const startedAt = currentLog?.startedAt ?? state.updatedAt;

	return (
		<section className="space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm">
			{isReviewing ? (
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
						<Spinner size={14} />
						<strong className="text-text-primary">Reviewer running</strong>
						<span className="text-text-secondary">{currentLog?.reviewerAgentId ?? "Starting…"}</span>
						<span className="text-text-secondary">
							Round {state.round + 1} · {state.round}/{MAX_FIX_ROUNDS} fix rounds used
						</span>
						<span className="font-mono text-text-secondary">{formatElapsed(now - startedAt)}</span>
					</div>
					{currentLog ? <ReviewerOutput log={currentLog} /> : null}
				</div>
			) : log ? (
				<details>
					<summary className="cursor-pointer text-text-secondary">
						Last reviewer output · {log.reviewerAgentId} · round {log.round + 1}
					</summary>
					<div className="mt-2">
						<ReviewerOutput log={log} />
					</div>
				</details>
			) : null}
			{state.fixPrompts.length > 0 ? (
				<details>
					<summary className="cursor-pointer text-text-secondary">
						Fix prompts sent ({state.fixPrompts.length})
					</summary>
					<ol className="m-0 mt-2 space-y-2 pl-5">
						{state.fixPrompts.map((fixPrompt, index) => (
							<li key={index} className="text-text-secondary">
								<span className="text-xs font-semibold">Round {index + 1}</span>
								<p className="m-0 whitespace-pre-wrap text-text-primary">{fixPrompt}</p>
							</li>
						))}
					</ol>
				</details>
			) : null}
		</section>
	);
}
