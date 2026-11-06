import { describe, expect, it } from "vitest";

import { getHandOffCount, getReviewRoundCap, nextEligibleHandOffAgent } from "../../../src/core/hand-off-cap";

describe("hand-off review caps", () => {
	it.each([
		[{ handOffCount: 0 }, 3],
		[{ handOffCount: 1 }, 6],
		[{ handOffCount: 2 }, 9],
		[{ handedOff: true }, 6],
	] as const)("computes the cap for %o", (card, cap) => {
		expect(getReviewRoundCap(card)).toBe(cap);
	});

	it("prefers handOffCount to the legacy flag", () => {
		expect(getHandOffCount({ handOffCount: 0, handedOff: true })).toBe(0);
	});
});

describe("nextEligibleHandOffAgent", () => {
	it("skips ineligible agents", () => {
		expect(nextEligibleHandOffAgent("codex", (agent) => agent === "antigravity")).toBe("antigravity");
	});

	it("falls back to the plain next agent when none is eligible", () => {
		expect(nextEligibleHandOffAgent("codex", () => false)).toBe("opencode");
	});
});
