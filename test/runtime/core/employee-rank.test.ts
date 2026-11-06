import { describe, expect, it } from "vitest";
import type { RuntimeBoardData } from "../../../src/core/api-contract";
import { outOfQuotaAgentIds, rankEmployees } from "../../../src/core/employee-rank";
import type { EmployeeProfile } from "../../../src/state/employees";

function profile(key: string, overrides: Partial<EmployeeProfile> = {}): EmployeeProfile {
	const [agentId = key, model = null] = key.split(":");
	return {
		key,
		agentId,
		model,
		status: "active",
		strong: [],
		avoid: [],
		notes: "",
		score: { agentId: key, score: 0, passes: 0, fails: 0, tasks: 0 },
		areas: {},
		...overrides,
	};
}

function rank(profiles: EmployeeProfile[], extra: { outOfQuota?: Set<string>; agentIds?: string[] } = {}) {
	return rankEmployees({
		profiles,
		areas: ["web-ui"],
		difficulty: 2,
		outOfQuota: extra.outOfQuota ?? new Set(),
		agentIds: extra.agentIds,
	}).map((r) => r.key);
}

describe("rankEmployees", () => {
	it("prefers the better area rate", () => {
		const good = profile("codex:a", { areas: { "web-ui": { passes: 9, fails: 1 } } });
		const thin = profile("opencode:b", { areas: { "web-ui": { passes: 1, fails: 0 } } });
		expect(rank([thin, good])).toEqual(["codex:a", "opencode:b"]);
	});
	it("strong tag beats better rate", () => {
		const good = profile("codex:a", { areas: { "web-ui": { passes: 9, fails: 1 } } });
		const strong = profile("opencode:b", { strong: ["web-ui"] });
		expect(rank([good, strong])).toEqual(["opencode:b", "codex:a"]);
	});
	it("excludes avoid and inactive", () => {
		expect(rank([profile("codex", { avoid: ["web-ui"] }), profile("opencode", { status: "inactive" })])).toEqual([]);
	});
	it("excludes out-of-quota agents and filters agentIds", () => {
		const profiles = [profile("codex:a"), profile("opencode:b")];
		expect(rank(profiles, { outOfQuota: new Set(["codex"]) })).toEqual(["opencode:b"]);
		expect(rank(profiles, { agentIds: ["opencode"] })).toEqual(["opencode:b"]);
	});
	it("returns [] for no profiles", () => {
		expect(rank([])).toEqual([]);
	});
	it("uses passes for difficulty >= 4 and score otherwise, then key", () => {
		const a = profile("codex", { score: { agentId: "codex", score: 1, passes: 5, fails: 4, tasks: 9 } });
		const b = profile("opencode", { score: { agentId: "opencode", score: 3, passes: 3, fails: 0, tasks: 3 } });
		const run = (difficulty: number) =>
			rankEmployees({ profiles: [a, b], areas: [], difficulty, outOfQuota: new Set() }).map((r) => r.key);
		expect(run(2)).toEqual(["opencode", "codex"]);
		expect(run(4)).toEqual(["codex", "opencode"]);
	});
	it("explains the choice in a short reason", () => {
		const result = rankEmployees({
			profiles: [profile("codex", { areas: { "web-ui": { passes: 7, fails: 1 } } })],
			areas: ["web-ui"],
			difficulty: 2,
			outOfQuota: new Set(),
		});
		expect(result[0]?.reason).toBe("web-ui 7/1");
	});
});

describe("outOfQuotaAgentIds", () => {
	const now = 10_000_000;
	function board(quotaBlockedAt: number): RuntimeBoardData {
		return {
			columns: [
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "t1",
							title: "t",
							prompt: "p",
							startInPlanMode: false,
							agentId: "codex",
							quotaBlockedAt,
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
			],
			dependencies: [],
		};
	}
	it("counts one hour", () => {
		expect(outOfQuotaAgentIds(board(now - 1000), now).has("codex")).toBe(true);
		expect(outOfQuotaAgentIds(board(now - 3_600_001), now).has("codex")).toBe(false);
	});
});
