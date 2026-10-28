import { describe, expect, it } from "vitest";

import { getRuntimeLaunchSupportedAgentCatalog, isRuntimeAgentLaunchSupported } from "../../../src/core/agent-catalog";

describe("agent-catalog launch support", () => {
	it("supports launching opencode tasks", () => {
		expect(isRuntimeAgentLaunchSupported("opencode")).toBe(true);
		expect(getRuntimeLaunchSupportedAgentCatalog().map((entry) => entry.id)).toContain("opencode");
	});

	it("keeps gemini launch-gated", () => {
		expect(isRuntimeAgentLaunchSupported("gemini")).toBe(false);
	});
});
