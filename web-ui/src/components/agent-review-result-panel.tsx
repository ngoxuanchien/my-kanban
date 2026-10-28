import type { RuntimeAgentReviewState } from "@/runtime/types";

const SUMMARY_FIELDS = [
	["What was done", "whatWasDone"],
	["What it affects", "whatItAffects"],
	["Against the request", "againstRequest"],
	["How it was verified", "howVerified"],
	["Risks / check by hand", "risks"],
] as const;

export function AgentReviewResultPanel({ state }: { state: RuntimeAgentReviewState }): React.ReactElement {
	return (
		<section className="space-y-3 rounded-lg border border-border bg-surface-2 p-3 text-sm">
			{state.status === "needs_user" ? (
				<div>
					<strong>Needs your review</strong>
					{state.reason ? (
						<p className="m-0 text-text-secondary">
							{state.reason.replaceAll("_", " ")}
							{state.reasonDetail ? `: ${state.reasonDetail}` : ""}
						</p>
					) : null}
					{state.lastResult?.verdict ? (
						<p className="m-0 text-text-secondary">Verdict: {state.lastResult.verdict}</p>
					) : null}
					{state.fixPrompts.at(-1) ? (
						<p className="m-0 whitespace-pre-wrap text-text-secondary">{state.fixPrompts.at(-1)}</p>
					) : null}
				</div>
			) : null}
			{state.summary ? (
				<div className="space-y-2">
					{SUMMARY_FIELDS.map(([heading, field]) => (
						<div key={field}>
							<h3 className="m-0 text-xs font-semibold text-text-secondary">{heading}</h3>
							<p className="m-0 whitespace-pre-wrap text-text-primary">{state.summary?.[field]}</p>
						</div>
					))}
				</div>
			) : null}
			{state.meta ? (
				<div className="border-t border-border pt-2 text-xs text-text-secondary">
					Meta · {state.meta.commitHash ? `Commit ${state.meta.commitHash} · ` : ""}
					{state.meta.rounds} rounds · {state.meta.reviewerAgentId} ·{" "}
					{new Date(state.meta.reviewedAt).toLocaleString()}
				</div>
			) : null}
		</section>
	);
}
