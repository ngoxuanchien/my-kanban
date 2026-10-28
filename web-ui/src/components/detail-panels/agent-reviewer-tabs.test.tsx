import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentReviewerTabs } from "@/components/detail-panels/agent-reviewer-tabs";
import { ReviewerTerminalPanel } from "@/components/detail-panels/reviewer-terminal-panel";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState, RuntimeTaskSessionSummary } from "@/runtime/types";

// xterm does not run in jsdom; the real panel is the task agent's terminal.
vi.mock("@/components/detail-panels/agent-terminal-panel", () => ({
	AgentTerminalPanel: ({
		taskId,
		workspaceId,
		summary,
	}: {
		taskId: string;
		workspaceId: string | null;
		summary: RuntimeTaskSessionSummary | null;
	}) => (
		<div id="reviewer-terminal" data-task-id={taskId} data-workspace-id={workspaceId ?? ""}>
			{summary?.startedAt ?? "no session"}
		</div>
	),
}));

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
};

const reviewerSession = { taskId: "agent-review:task-1", startedAt: 9_999 } as RuntimeTaskSessionSummary;

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
			root.render(
				<AgentReviewerTabs
					agentPanel={<div id="task-terminal">task</div>}
					reviewerPanel={
						<ReviewerTerminalPanel
							taskId="task-1"
							workspaceId="project-1"
							state={state}
							log={log}
							summary={reviewerSession}
							terminalBackgroundColor="#000"
							cursorColor="#fff"
						/>
					}
					state={state}
				/>,
			),
		);
	const tab = (label: string) =>
		[...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find((button) =>
			button.textContent?.startsWith(label),
		);
	const reviewerText = () => container.querySelector("section[aria-label='Reviewer output']")?.textContent ?? null;
	const reviewerTerminal = () => container.querySelector<HTMLElement>("#reviewer-terminal");

	it("opens the reviewer's live terminal while reviewing and switches back to the task agent", () => {
		render(reviewing, liveLog);
		expect(tab("Reviewer")?.getAttribute("aria-selected")).toBe("true");
		expect(tab("Reviewer")?.textContent).toBe("Reviewer (live)");
		expect(reviewerText()).toContain("Reviewer · claude");
		expect(reviewerText()).toContain("Round 2 · 1/3 fix rounds used");
		expect(reviewerText()).toContain("1:05");
		expect(reviewerTerminal()?.dataset.taskId).toBe("agent-review:task-1");
		expect(reviewerTerminal()?.dataset.workspaceId).toBe("project-1");
		expect(reviewerTerminal()?.textContent).toBe("9999");

		act(() => tab("Task agent")?.click());
		expect(reviewerText()).toBeNull();
		// The task terminal was mounted the whole time, only hidden.
		expect(container.querySelector("#task-terminal")?.parentElement?.className).toContain("flex");
	});

	it("waits for the current run instead of showing the previous run", () => {
		render(reviewing, { ...liveLog, round: 0, finishedAt: 5000 });
		expect(reviewerText()).toContain("Reviewer · starting…");
		expect(reviewerText()).toContain("Starting the reviewer…");
		expect(reviewerTerminal()).toBeNull();
	});

	it("keeps the finished reviewer terminal viewable after the review ends", () => {
		const passed: RuntimeAgentReviewState = { ...reviewing, status: "passed" };
		render(passed, { ...liveLog, finishedAt: 40_000 });
		expect(tab("Task agent")?.getAttribute("aria-selected")).toBe("true");
		expect(reviewerText()).toBeNull();

		act(() => tab("Reviewer")?.click());
		expect(reviewerText()).toContain("0:30 · finished");
		expect(reviewerTerminal()?.dataset.taskId).toBe("agent-review:task-1");
	});

	it("explains that a Cline reviewer has no terminal", () => {
		render(reviewing, { ...liveLog, reviewerAgentId: "cline" });
		expect(reviewerText()).toContain("no terminal to show");
		expect(reviewerTerminal()).toBeNull();
	});

	it("switches to the reviewer when a new review starts", () => {
		render({ ...reviewing, status: "fixing" }, null);
		expect(tab("Task agent")?.getAttribute("aria-selected")).toBe("true");
		render(reviewing, liveLog);
		expect(tab("Reviewer")?.getAttribute("aria-selected")).toBe("true");
	});
});
