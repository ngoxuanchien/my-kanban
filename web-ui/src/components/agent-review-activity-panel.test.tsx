import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentReviewActivityPanel, formatElapsed } from "@/components/agent-review-activity-panel";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";

const reviewing: RuntimeAgentReviewState = {
	status: "reviewing",
	round: 1,
	reason: null,
	reasonDetail: null,
	fingerprint: null,
	lastResult: null,
	fixPrompts: ["Fix the button."],
	summary: null,
	meta: null,
	updatedAt: 0,
};

const liveLog: RuntimeAgentReviewLog = {
	reviewerAgentId: "codex",
	round: 1,
	startedAt: 10_000,
	finishedAt: null,
	output: "running npm test\n",
	truncated: false,
};

describe("formatElapsed", () => {
	it("formats minutes and padded seconds", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(65_400)).toBe("1:05");
		expect(formatElapsed(-5)).toBe("0:00");
	});
});

describe("AgentReviewActivityPanel", () => {
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

	it("shows agent, round, elapsed time and earlier fix prompts while reviewing", () => {
		act(() => root.render(<AgentReviewActivityPanel state={reviewing} log={liveLog} />));
		const text = container.textContent ?? "";
		expect(text).toContain("Reviewer running");
		expect(text).toContain("codex");
		expect(text).toContain("Round 2 · 1/3 fix rounds used");
		expect(text).toContain("1:05");
		expect(text).toContain("Live output in the Reviewer tab");
		expect(container.querySelector("pre")).toBeNull();
		expect(text).toContain("Fix prompts sent (1)");
		expect(text).toContain("Fix the button.");

		act(() => vi.advanceTimersByTime(2000));
		expect(container.textContent).toContain("1:07");
	});

	it("ignores a finished log from the previous run while the next one starts", () => {
		const previous = { ...liveLog, round: 0, finishedAt: 5000, output: "old run" };
		act(() => root.render(<AgentReviewActivityPanel state={reviewing} log={previous} />));
		expect(container.textContent).toContain("Starting…");
	});

	it("keeps only the fix prompts after the review ends", () => {
		const done: RuntimeAgentReviewState = { ...reviewing, status: "needs_user", reason: "reviewer_crashed" };
		const finished = { ...liveLog, finishedAt: 20_000, output: "tail" };
		act(() => root.render(<AgentReviewActivityPanel state={done} log={finished} />));
		expect(container.textContent).toContain("Fix prompts sent (1)");
		expect(container.textContent).not.toContain("Reviewer running");
		expect(container.textContent).not.toContain("tail");
	});

	it("renders nothing without a run, log or fix prompts", () => {
		const queued: RuntimeAgentReviewState = { ...reviewing, status: "queued", fixPrompts: [] };
		act(() => root.render(<AgentReviewActivityPanel state={queued} log={null} />));
		expect(container.innerHTML).toBe("");
	});
});
