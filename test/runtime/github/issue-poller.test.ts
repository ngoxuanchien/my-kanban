import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_ISSUE_POLL_INTERVAL_MS, startGithubIssuePolling } from "../../../src/github/issue-poller";

describe("startGithubIssuePolling", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("requests one sync per workspace per tick and stops when cleared", async () => {
		const requestSync = vi.fn();
		const stop = startGithubIssuePolling({
			sync: { requestSync },
			listWorkspaces: async () => [{ workspaceId: "w", repoPath: "/r" }],
		});
		await vi.advanceTimersByTimeAsync(GITHUB_ISSUE_POLL_INTERVAL_MS * 3);
		expect(requestSync).toHaveBeenCalledTimes(3);
		expect(requestSync).toHaveBeenCalledWith("w", "/r", { pull: true });
		stop();
		await vi.advanceTimersByTimeAsync(GITHUB_ISSUE_POLL_INTERVAL_MS * 3);
		expect(requestSync).toHaveBeenCalledTimes(3);
	});

	it("does nothing when no workspace is registered and survives a listing failure", async () => {
		const requestSync = vi.fn();
		const stop = startGithubIssuePolling({
			sync: { requestSync },
			listWorkspaces: async () => {
				throw new Error("index unreadable");
			},
		});
		await vi.advanceTimersByTimeAsync(GITHUB_ISSUE_POLL_INTERVAL_MS * 2);
		expect(requestSync).not.toHaveBeenCalled();
		stop();
	});
});
