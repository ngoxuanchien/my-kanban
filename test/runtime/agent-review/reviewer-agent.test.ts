import { describe, expect, it } from "vitest";

import { resolveReviewerAgentId } from "../../../src/agent-review/reviewer-agent";

describe("resolveReviewerAgentId", () => {
	it("same_as_task returns the task agent", () => {
		expect(resolveReviewerAgentId("same_as_task", "opencode")).toBe("opencode");
	});
	it("a fixed agent wins regardless of task agent", () => {
		expect(resolveReviewerAgentId("claude", "codex")).toBe("claude");
	});
	it("cross maps opencode → codex and codex → opencode", () => {
		expect(resolveReviewerAgentId("cross", "opencode")).toBe("codex");
		expect(resolveReviewerAgentId("cross", "codex")).toBe("opencode");
	});
	it("cross keeps other agents unchanged", () => {
		for (const agent of ["claude", "cline", "gemini", "droid", "kiro"] as const) {
			expect(resolveReviewerAgentId("cross", agent)).toBe(agent);
		}
	});
});
