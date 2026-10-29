import { describe, expect, it } from "vitest";
import { detectUsageLimit, USAGE_LIMIT_PHRASES } from "../../../src/server/usage-limit-detector";

describe("detectUsageLimit", () => {
	it.each(USAGE_LIMIT_PHRASES)("detects %s in ANSI-colored text", (phrase) => {
		expect(detectUsageLimit(`\u001B[31m${phrase}\u001B[0m`)).toBe(phrase);
	});

	it("matches case-insensitively", () => {
		expect(detectUsageLimit("FREE USAGE LIMIT REACHED")).toBe("Free usage limit reached");
		expect(detectUsageLimit("model gemini-pro is OUT OF QUOTA UNTIL 14:00")).toBe("out of quota until");
	});

	it("matches Antigravity quota text in ANSI-colored output", () => {
		expect(
			detectUsageLimit(
				`${String.fromCharCode(27)}[31mYou have exhausted your quota on this model.${String.fromCharCode(27)}[0m`,
			),
		).toBe("exhausted your quota");
	});

	it("matches Codex usage-limit text with a curly apostrophe", () => {
		expect(detectUsageLimit("You’ve hit your usage limit. Upgrade to Plus to continue using Codex")).toBe(
			"hit your usage limit",
		);
	});

	it("matches an OpenCode error wrapped across terminal rows", () => {
		expect(detectUsageLimit("AI.Error.QuotaExceeded: Free usage limit\nreached. Free models work in OpenCode")).toBe(
			"Free usage limit reached",
		);
	});

	it("ignores phrases above the last 40 lines", () => {
		expect(
			detectUsageLimit(["hit your usage limit", ...Array.from({ length: 40 }, () => "still running")].join("\n")),
		).toBe(null);
	});

	it("returns null for plain text", () => {
		expect(detectUsageLimit("Task finished successfully")).toBeNull();
	});
});
