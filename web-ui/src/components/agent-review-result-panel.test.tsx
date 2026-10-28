import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentReviewResultPanel } from "@/components/agent-review-result-panel";
import type { RuntimeAgentReviewState } from "@/runtime/types";

const state: RuntimeAgentReviewState = {
	status: "passed",
	round: 2,
	reason: null,
	reasonDetail: null,
	fingerprint: "abc",
	fixPrompts: [],
	updatedAt: 1,
	lastResult: null,
	summary: {
		whatWasDone: "Added review",
		whatItAffects: "Task flow",
		againstRequest: "Nothing",
		howVerified: "Tests pass",
		risks: "Check manually",
	},
	meta: { commitHash: "deadbeef", prUrl: null, rounds: 2, reviewerAgentId: "codex", reviewedAt: 1 },
};

describe("AgentReviewResultPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
	});
	it("renders the five summary headings and the commit hash", () => {
		act(() => root.render(<AgentReviewResultPanel state={state} />));
		for (const heading of [
			"What was done",
			"What it affects",
			"Against the request",
			"How it was verified",
			"Risks / check by hand",
		])
			expect(container.textContent).toContain(heading);
		expect(container.textContent).toContain("deadbeef");
	});
	it("shows reason detail paths for reviewer_modified_worktree", () => {
		act(() =>
			root.render(
				<AgentReviewResultPanel
					state={{
						...state,
						status: "needs_user",
						reason: "reviewer_modified_worktree",
						reasonDetail: "src/app.ts",
					}}
				/>,
			),
		);
		expect(container.textContent).toContain("src/app.ts");
	});
});
