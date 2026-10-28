import { describe, expect, it } from "vitest";

import { buildFixPromptMessage, buildReviewerPrompt } from "../../../src/agent-review/reviewer-prompt";

describe("buildReviewerPrompt", () => {
	it("includes title, verbatim prompt, baseRef and result markers", () => {
		const prompt = buildReviewerPrompt({
			title: "Fix it",
			prompt: "Original\nrequest",
			baseRef: "main",
			round: 1,
			previousFixPrompts: [],
		});
		expect(prompt).toContain("Fix it");
		expect(prompt).toContain("Original\nrequest");
		expect(prompt).toContain("main");
		expect(prompt).toContain("git diff <merge-base>...HEAD");
		expect(prompt).toContain("<<<KANBAN_AGENT_REVIEW_RESULT");
		expect(prompt).toContain("KANBAN_AGENT_REVIEW_RESULT>>>");
	});

	it("lists earlier fix prompts numbered from round 2", () => {
		const prompt = buildReviewerPrompt({
			title: "t",
			prompt: "p",
			baseRef: "main",
			round: 3,
			previousFixPrompts: ["first", "second"],
		});
		expect(prompt).toContain("1. first");
		expect(prompt).toContain("2. second");
	});

	it("omits the earlier-fixes section in round 1", () => {
		const prompt = buildReviewerPrompt({
			title: "t",
			prompt: "p",
			baseRef: "main",
			round: 1,
			previousFixPrompts: [],
		});
		expect(prompt).not.toContain("Earlier fix prompts");
	});

	it("starts fix message with the round header", () => {
		expect(buildFixPromptMessage({ fixPrompt: "Fix the issue", round: 2, maxRounds: 3 })).toMatch(
			/^\[Kanban agent review — fix round 2\/3\]/,
		);
	});
});
