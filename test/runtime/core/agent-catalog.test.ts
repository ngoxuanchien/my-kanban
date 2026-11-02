import { describe, expect, it } from "vitest";

import {
	getRuntimeLaunchSupportedAgentCatalog,
	isRuntimeAgentLaunchSupported,
	RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS,
} from "../../../src/core/agent-catalog";

describe("agent-catalog launch support", () => {
	it("supports only the four enabled task agents", () => {
		expect(RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS).toEqual(["claude", "codex", "antigravity", "opencode"]);
	});

	it("supports launching opencode tasks", () => {
		expect(isRuntimeAgentLaunchSupported("opencode")).toBe(true);
		expect(getRuntimeLaunchSupportedAgentCatalog().map((entry) => entry.id)).toContain("opencode");
	});

	it("keeps gemini launch-gated", () => {
		for (const agentId of ["cline", "droid", "kiro", "gemini"] as const) {
			expect(isRuntimeAgentLaunchSupported(agentId)).toBe(false);
		}
	});
});
