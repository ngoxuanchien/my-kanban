import { describe, expect, it } from "vitest";

import { parseReviewerVerdict } from "../../../src/agent-review/reviewer-output";

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

describe("parseReviewerVerdict", () => {
	it("parses a valid pass verdict", () => {
		expect(parseReviewerVerdict(JSON.stringify(pass))).toEqual({ ok: true, result: pass });
	});

	it("accepts JSON wrapped in a json fence", () => {
		expect(parseReviewerVerdict(`\`\`\`json\n${JSON.stringify(pass)}\n\`\`\`\n`)).toEqual({ ok: true, result: pass });
	});

	it("fails when the verdict file is missing", () => {
		expect(parseReviewerVerdict(null)).toEqual({ ok: false, error: "reviewer did not write the verdict file" });
	});

	it("fails a pass without summary", () => {
		expect(parseReviewerVerdict(JSON.stringify({ ...pass, summary: null }))).toMatchObject({ ok: false });
	});

	it("fails a fail verdict without fixPrompt", () => {
		expect(
			parseReviewerVerdict(JSON.stringify({ ...pass, verdict: "fail", summary: null, fixPrompt: null })),
		).toMatchObject({ ok: false });
	});

	it("fails on invalid JSON", () => {
		expect(parseReviewerVerdict('{"verdict": "pass",')).toEqual({
			ok: false,
			error: "verdict file contains invalid JSON",
		});
	});

	it("fails on a wrong shape", () => {
		expect(parseReviewerVerdict(JSON.stringify({ verdict: "maybe" }))).toMatchObject({
			ok: false,
			error: expect.stringContaining("invalid result shape"),
		});
	});
});
