import { describe, expect, it } from "vitest";

import { runtimeBoardCardSchema } from "../../../src/core/api-contract";
import { isRuntimeClaudeAgent, readCliAgentOption, runtimeClaudeAgentSchema } from "../../../src/core/claude-agent";

describe("runtime claude agent helpers", () => {
	it("accepts specialist names and rejects invalid names", () => {
		for (const value of ["debugger", "database-admin", "ecc:typescript-reviewer"]) {
			expect(runtimeClaudeAgentSchema.safeParse(value).success).toBe(true);
			expect(isRuntimeClaudeAgent(value)).toBe(true);
		}
		for (const value of ["", "-x", "a b", "x".repeat(257)]) {
			expect(runtimeClaudeAgentSchema.safeParse(value).success).toBe(false);
			expect(isRuntimeClaudeAgent(value)).toBe(false);
		}
	});

	it("reads Claude's --agent option", () => {
		expect(readCliAgentOption(["--agent", "debugger"])).toBe("debugger");
		expect(readCliAgentOption(["--agent=ecc:reviewer"])).toBe("ecc:reviewer");
		expect(readCliAgentOption(["--model", "sonnet"])).toBeNull();
		expect(readCliAgentOption(["--agent"])).toBeNull();
	});

	it("parses cards with and without a Claude agent", () => {
		const card = {
			id: "task-1",
			prompt: "Do the thing",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
		};
		expect(runtimeBoardCardSchema.parse(card).claudeAgent).toBeUndefined();
		expect(runtimeBoardCardSchema.parse({ ...card, claudeAgent: "debugger" }).claudeAgent).toBe("debugger");
	});
});
