import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_REVIEW_LOG_POLL_INTERVAL_MS, useAgentReviewLog } from "@/hooks/use-agent-review-log";
import type { RuntimeAgentReviewLog, RuntimeAgentReviewState } from "@/runtime/types";

const getAgentReviewLogQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: { getAgentReviewLog: { query: getAgentReviewLogQueryMock } },
	}),
}));

const log: RuntimeAgentReviewLog = {
	reviewerAgentId: "claude",
	round: 0,
	startedAt: 1,
	finishedAt: null,
};

function reviewState(status: RuntimeAgentReviewState["status"]): RuntimeAgentReviewState {
	return {
		status,
		round: 0,
		reason: null,
		reasonDetail: null,
		fingerprint: null,
		lastResult: null,
		fixPrompts: [],
		summary: null,
		meta: null,
		updatedAt: 0,
	};
}

let latest: RuntimeAgentReviewLog | null = null;

function Harness({ state }: { state: RuntimeAgentReviewState | undefined }): null {
	latest = useAgentReviewLog("project-1", "task-1", state);
	return null;
}

describe("useAgentReviewLog", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		vi.useFakeTimers();
		getAgentReviewLogQueryMock.mockReset();
		getAgentReviewLogQueryMock.mockResolvedValue({ log });
		latest = null;
		container = document.createElement("div");
		root = createRoot(container);
	});
	afterEach(() => {
		act(() => root.unmount());
		vi.useRealTimers();
	});

	it("does not query without agent review state", async () => {
		await act(async () => root.render(<Harness state={undefined} />));
		expect(getAgentReviewLogQueryMock).not.toHaveBeenCalled();
		expect(latest).toBeNull();
	});

	it("polls while reviewing and stops once the review ends", async () => {
		await act(async () => root.render(<Harness state={reviewState("reviewing")} />));
		expect(getAgentReviewLogQueryMock).toHaveBeenCalledWith({ taskId: "task-1" });
		expect(latest).toEqual(log);

		await act(async () => vi.advanceTimersByTime(AGENT_REVIEW_LOG_POLL_INTERVAL_MS * 2));
		expect(getAgentReviewLogQueryMock).toHaveBeenCalledTimes(3);

		// The status change fetches the finished run once, then polling stops.
		await act(async () => root.render(<Harness state={reviewState("needs_user")} />));
		expect(getAgentReviewLogQueryMock).toHaveBeenCalledTimes(4);
		await act(async () => vi.advanceTimersByTime(AGENT_REVIEW_LOG_POLL_INTERVAL_MS * 3));
		expect(getAgentReviewLogQueryMock).toHaveBeenCalledTimes(4);
	});
});
