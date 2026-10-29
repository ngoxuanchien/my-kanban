import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mapAntigravityHookEvent } from "../../src/commands/hooks";

describe("Antigravity lifecycle hooks", () => {
	it("maps lifecycle events to Kanban transitions", () => {
		expect(mapAntigravityHookEvent("Stop", { terminationReason: "NO_TOOL_CALL" })).toBe("to_review");
		expect(mapAntigravityHookEvent("Stop", { terminationReason: "ERROR" })).toBe("to_review");
		expect(mapAntigravityHookEvent("Stop", { terminationReason: "USER_CANCELED" })).toBeNull();
		expect(mapAntigravityHookEvent("PreInvocation", {})).toBe("to_in_progress");
		expect(mapAntigravityHookEvent("PreToolUse", {})).toBe("activity");
		expect(mapAntigravityHookEvent("PostToolUse", {})).toBe("activity");
	});

	it.each(["", "not json"])('prints valid JSON for stdin "%s"', (input) => {
		const result = spawnSync(
			process.execPath,
			[
				join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
				"src/cli.ts",
				"hooks",
				"antigravity-hook",
				"--event",
				"Stop",
			],
			{ encoding: "utf8", input, timeout: 15_000 },
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("{}\n");
	});

	it("allows Antigravity tool calls after reporting activity", () => {
		const result = spawnSync(
			process.execPath,
			[
				join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
				"src/cli.ts",
				"hooks",
				"antigravity-hook",
				"--event",
				"PreToolUse",
			],
			{ encoding: "utf8", input: "{}", timeout: 15_000 },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('{"decision":"allow"}\n');
	});
});
