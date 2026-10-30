import { describe, expect, it } from "vitest";
import {
	findAntigravityLogUsageLimit,
	selectNewestAntigravityLogFiles,
} from "../../../src/server/antigravity-log-usage-limit";

const fileName = "cli-20261030_153449.log";
const log = (workspacePath: string, level = "E", name = fileName) => ({
	fileName: name,
	text: `I1030 15:34:49.929249       1 server.go:307] Creating CLI server backend: product=antigravity workspaceDirs=[${workspacePath} ${workspacePath}] appDataDir=...\n${level}1030 15:34:55.121136     814 errorreport.go:224] agent executor error: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 145h11m11s.`,
});

describe("findAntigravityLogUsageLimit", () => {
	it("matches an error quota line for the task worktree", () => {
		expect(findAntigravityLogUsageLimit([log("/repo/task")], { worktreePath: "/repo/task", sinceMs: 0 })).toBe(
			"Individual quota reached",
		);
	});

	it("ignores a different worktree", () => {
		expect(findAntigravityLogUsageLimit([log("/repo/other")], { worktreePath: "/repo/task", sinceMs: 0 })).toBeNull();
	});

	it("accepts a log file name 30 seconds before the task", () => {
		const sinceMs = new Date(2026, 9, 30, 15, 34, 49).getTime();
		expect(
			findAntigravityLogUsageLimit([log("/repo/task", "E", "cli-20261030_153419.log")], {
				worktreePath: "/repo/task",
				sinceMs,
			}),
		).toBe("Individual quota reached");
	});

	it("ignores a log file name 61 seconds before the task", () => {
		const sinceMs = new Date(2026, 9, 30, 15, 34, 49).getTime();
		expect(
			findAntigravityLogUsageLimit([log("/repo/task", "E", "cli-20261030_153348.log")], {
				worktreePath: "/repo/task",
				sinceMs,
			}),
		).toBeNull();
	});

	it("ignores a quota phrase on an informational line", () => {
		expect(
			findAntigravityLogUsageLimit([log("/repo/task", "I")], { worktreePath: "/repo/task", sinceMs: 0 }),
		).toBeNull();
	});
});

describe("selectNewestAntigravityLogFiles", () => {
	it("returns at most the five newest valid CLI log names", () => {
		expect(
			selectNewestAntigravityLogFiles([
				"other.log",
				"cli-20261030_153449.log",
				"cli-20261030_153445.log",
				"cli-20261030_153448.log",
				"cli-20261030_153446.log",
				"cli-20261030_153447.log",
				"cli-20261030_153444.log",
			]),
		).toEqual([
			"cli-20261030_153449.log",
			"cli-20261030_153448.log",
			"cli-20261030_153447.log",
			"cli-20261030_153446.log",
			"cli-20261030_153445.log",
		]);
	});
});
