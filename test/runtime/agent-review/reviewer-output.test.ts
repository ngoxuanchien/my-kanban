import { describe, expect, it } from "vitest";

import {
	AGENT_REVIEW_RESULT_END,
	AGENT_REVIEW_RESULT_START,
	parseReviewerOutput,
} from "../../../src/agent-review/reviewer-output";

const pass = {
	verdict: "pass",
	appVerified: true,
	appCheck: "started",
	tests: [{ command: "npm test", result: "passed" }],
	summary: {
		whatWasDone: "done",
		whatItAffects: "app",
		againstRequest: "nothing",
		howVerified: "tests",
		risks: "none",
	},
	fixPrompt: null,
	notes: null,
};

function block(value: unknown): string {
	return `${AGENT_REVIEW_RESULT_START}\n${JSON.stringify(value)}\n${AGENT_REVIEW_RESULT_END}`;
}

describe("parseReviewerOutput", () => {
	it("parses a valid pass block", () => {
		expect(parseReviewerOutput(block(pass))).toEqual({ ok: true, result: pass });
	});

	it("uses the last block when there are two", () => {
		const fail = { ...pass, verdict: "fail", summary: null, fixPrompt: "Fix it" };
		expect(parseReviewerOutput(`${block(pass)}\n${block(fail)}`)).toEqual({ ok: true, result: fail });
	});

	it("accepts JSON wrapped in a json fence inside the markers", () => {
		expect(
			parseReviewerOutput(
				`${AGENT_REVIEW_RESULT_START}\n\`\`\`json\n${JSON.stringify(pass)}\n\`\`\`\n${AGENT_REVIEW_RESULT_END}`,
			),
		).toEqual({ ok: true, result: pass });
	});

	it("ignores prose after the end marker", () => {
		expect(parseReviewerOutput(`${block(pass)}\nAll done.`)).toEqual({ ok: true, result: pass });
	});

	it("fails with no block", () => {
		expect(parseReviewerOutput("done!")).toMatchObject({
			ok: false,
			error: expect.stringContaining("no result block"),
		});
	});

	it("fails a pass without summary", () => {
		expect(parseReviewerOutput(block({ ...pass, summary: null }))).toMatchObject({ ok: false });
	});

	it("fails a fail verdict without fixPrompt", () => {
		expect(parseReviewerOutput(block({ ...pass, verdict: "fail", summary: null, fixPrompt: null }))).toMatchObject({
			ok: false,
		});
	});

	it("fails on invalid JSON", () => {
		expect(parseReviewerOutput(`${AGENT_REVIEW_RESULT_START}\nnot json\n${AGENT_REVIEW_RESULT_END}`)).toMatchObject({
			ok: false,
		});
	});
});
