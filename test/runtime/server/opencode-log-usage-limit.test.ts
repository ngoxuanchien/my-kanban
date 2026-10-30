import { describe, expect, it } from "vitest";
import { findOpenCodeLogUsageLimit } from "../../../src/server/opencode-log-usage-limit";

describe("findOpenCodeLogUsageLimit", () => {
	const options = { worktreePath: "/worktree/task-1", sinceMs: Date.parse("2026-10-30T03:27:00.000Z") };
	const linkedRun =
		'timestamp=2026-10-30T03:27:26.454Z level=INFO run=abc message="connected" directory="/worktree/task-1"';

	it("finds a quota phrase on an error line linked to this worktree", () => {
		expect(
			findOpenCodeLogUsageLimit(
				`${linkedRun}\ntimestamp=2026-10-30T03:27:31.247Z level=ERROR run=abc cause="AI.Error: Free usage limit reached"`,
				options,
			),
		).toBe("Free usage limit reached");
	});

	it("ignores a different worktree's run", () => {
		expect(
			findOpenCodeLogUsageLimit(
				`${linkedRun.replace("task-1", "task-2")}\ntimestamp=2026-10-30T03:27:31.247Z level=ERROR run=abc cause="Free usage limit reached"`,
				options,
			),
		).toBeNull();
	});

	it("ignores an error older than the task session", () => {
		expect(
			findOpenCodeLogUsageLimit(
				`${linkedRun}\ntimestamp=2026-10-30T03:26:59.999Z level=ERROR run=abc cause="Free usage limit reached"`,
				options,
			),
		).toBeNull();
	});

	it("returns null when no quota phrase is present", () => {
		expect(
			findOpenCodeLogUsageLimit(
				`${linkedRun}\ntimestamp=2026-10-30T03:27:31.247Z level=ERROR run=abc cause="Failed"`,
				options,
			),
		).toBeNull();
	});
});
