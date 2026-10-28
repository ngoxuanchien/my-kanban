import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentReviewerTabs } from "@/components/detail-panels/agent-reviewer-tabs";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";

const reviewing: RuntimeAgentReviewState = {
	status: "reviewing",
	round: 1,
	reason: null,
	reasonDetail: null,
	fingerprint: null,
	lastResult: null,
	fixPrompts: [],
	summary: null,
	meta: null,
	updatedAt: 0,
};

const liveLog: RuntimeAgentReviewLog = {
	reviewerAgentId: "claude",
	round: 1,
	startedAt: 10_000,
	finishedAt: null,
	output: "$ npm test\n  3 passed\n",
	truncated: false,
};

describe("AgentReviewerTabs", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(75_000);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		vi.useRealTimers();
	});

	const render = (state: RuntimeAgentReviewState, log: RuntimeAgentReviewLog | null) =>
		act(() =>
			root.render(<AgentReviewerTabs agentPanel={<div id="task-terminal">task</div>} state={state} log={log} />),
		);
	const tab = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) =>
			button.textContent?.startsWith(label),
		);
	const reviewerText = () => container.querySelector("section[aria-label='Reviewer output']")?.textContent ?? null;

	it("opens the labeled live reviewer output while reviewing and switches back to the task agent", () => {
		render(reviewing, liveLog);
		expect(tab("Reviewer")?.getAttribute("aria-selected")).toBe("true");
		expect(tab("Reviewer")?.textContent).toBe("Reviewer (live)");
		expect(reviewerText()).toContain("Reviewer · claude");
		expect(reviewerText()).toContain("Round 2 · 1/3 fix rounds used");
		expect(reviewerText()).toContain("1:05");
		expect(container.querySelector("pre")?.textContent).toBe("$ npm test\n  3 passed\n");

		act(() => tab("Task agent")?.click());
		expect(reviewerText()).toBeNull();
		// The task terminal was mounted the whole time, only hidden.
		expect(container.querySelector("#task-terminal")?.parentElement?.className).toContain("flex");

		render(reviewing, { ...liveLog, output: `${liveLog.output}more\n` });
		expect(reviewerText()).toBeNull();
	});

	it("waits for the current run instead of showing the previous run's finished log", () => {
		render(reviewing, { ...liveLog, round: 0, finishedAt: 5000, output: "old run" });
		expect(reviewerText()).toContain("Reviewer · starting…");
		expect(container.querySelector("pre")?.textContent).toBe("Waiting for reviewer output…");
	});

	it("keeps the finished reviewer output viewable after the review ends", () => {
		const passed: RuntimeAgentReviewState = { ...reviewing, status: "passed" };
		render(passed, { ...liveLog, finishedAt: 40_000, truncated: true });
		expect(tab("Task agent")?.getAttribute("aria-selected")).toBe("true");
		expect(reviewerText()).toBeNull();

		act(() => tab("Reviewer")?.click());
		expect(reviewerText()).toContain("0:30 · finished");
		expect(reviewerText()).toContain("Showing the end of the output.");
		expect(container.querySelector("pre")?.textContent).toBe(liveLog.output);
	});

	it("switches to the reviewer when a new review starts", () => {
		render({ ...reviewing, status: "fixing" }, null);
		expect(tab("Task agent")?.getAttribute("aria-selected")).toBe("true");
		render(reviewing, liveLog);
		expect(tab("Reviewer")?.getAttribute("aria-selected")).toBe("true");
	});
});
