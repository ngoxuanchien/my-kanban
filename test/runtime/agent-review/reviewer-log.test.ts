import { describe, expect, it } from "vitest";

import { appendReviewerLog, createReviewerLog } from "../../../src/agent-review/reviewer-log";

describe("reviewer log", () => {
	it("appends chunks while under the cap", () => {
		const log = appendReviewerLog(appendReviewerLog(createReviewerLog("claude", 1, 100), "ab"), "cd", 10);
		expect(log).toEqual({
			reviewerAgentId: "claude",
			round: 1,
			startedAt: 100,
			finishedAt: null,
			output: "abcd",
			truncated: false,
		});
	});

	it("keeps only the tail and marks it truncated past the cap", () => {
		const log = appendReviewerLog(appendReviewerLog(createReviewerLog("codex", 0, 0), "123456", 8), "789", 8);
		expect(log.output).toBe("23456789");
		expect(log.truncated).toBe(true);
		expect(appendReviewerLog(log, "x", 8).truncated).toBe(true);
	});
});
