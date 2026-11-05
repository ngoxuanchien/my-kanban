import { describe, expect, it } from "vitest";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard } from "@/types";
import { getCardAttention, sortCardsByAttention } from "./card-attention";

const card: BoardCard = {
	id: "task",
	title: "Task",
	prompt: "Task",
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
	agentId: "codex",
	agentReviewEnabled: true,
};
const summary: RuntimeTaskSessionSummary = {
	taskId: "task",
	state: "awaiting_review",
	agentId: "codex",
	workspacePath: null,
	pid: null,
	startedAt: null,
	updatedAt: 1,
	lastOutputAt: null,
	reviewReason: "hook",
	exitCode: null,
	lastHookAt: null,
	latestHookActivity: null,
};

describe("getCardAttention", () => {
	it.each<[string, Partial<BoardCard>, Partial<RuntimeTaskSessionSummary> | undefined]>([
		["quota-blocked", { quotaBlockedAt: 1 }, undefined],
		["hook below cap", {}, {}],
		["exit zero below cap", {}, { reviewReason: "exit", exitCode: 0 }],
		["at cap with a handoff left", { handOffCount: 1, reviewRound: 6 }, {}],
		["failed with matching agent and handoffs left", {}, { state: "failed" }],
		["error with matching agent", {}, { reviewReason: "error" }],
		["nonzero exit with matching agent", {}, { reviewReason: "exit", exitCode: 1 }],
	])("sidebar: %s", (_name, fields, session) => {
		expect(
			getCardAttention(
				{ ...card, ...fields },
				"review",
				session === undefined ? undefined : { ...summary, ...session },
			),
		).toBe("sidebar");
	});
	it.each<[string, Partial<BoardCard>, Partial<RuntimeTaskSessionSummary> | undefined]>([
		["review off", { agentReviewEnabled: false }, {}],
		["no summary", {}, undefined],
		["idle", {}, { state: "idle", reviewReason: null }],
		["interrupted", {}, { state: "interrupted" }],
		["failed with agent mismatch", {}, { state: "failed", agentId: "opencode" }],
		["failed with no handoff left", { handOffCount: 2 }, { state: "failed" }],
		["at cap with no handoff left", { handOffCount: 2, reviewRound: 9 }, {}],
		["at cap with unsupported agent", { agentId: "claude", reviewRound: 3 }, {}],
		["exit without a code", {}, { reviewReason: "exit", exitCode: null }],
	])("owner: %s", (_name, fields, session) => {
		expect(
			getCardAttention(
				{ ...card, ...fields },
				"review",
				session === undefined ? undefined : { ...summary, ...session },
			),
		).toBe("owner");
	});
	it.each(["in_progress", "review"] as const)("blocked report is owner in %s, review on or off", (columnId) => {
		const blocked = { ...card, blockedReport: { question: "Q?", reportedAt: 1 } };
		expect(getCardAttention(blocked, columnId, summary)).toBe("owner");
		expect(getCardAttention({ ...blocked, agentReviewEnabled: false }, columnId, summary)).toBe("owner");
		expect(getCardAttention({ ...blocked, quotaBlockedAt: 1 }, columnId, undefined)).toBe("owner");
	});
	it.each(["backlog", "trash"] as const)("blocked report is null in %s", (columnId) => {
		expect(
			getCardAttention({ ...card, blockedReport: { question: "Q?", reportedAt: 1 } }, columnId, summary),
		).toBeNull();
	});
	it.each(["in_progress", "review"] as const)("waiting has no attention or sort priority in %s", (columnId) => {
		const waiting = { ...card, id: "waiting", waitingReport: { reason: "Experiment", reportedAt: 1 } };
		expect(getCardAttention(waiting, columnId, summary)).toBeNull();
		const ordinary = { ...card, id: "ordinary" };
		const blocked = { ...card, id: "blocked", blockedReport: { question: "Q?", reportedAt: 1 } };
		expect(
			sortCardsByAttention([ordinary, waiting, blocked], columnId, { ordinary: summary }).map(({ id }) => id),
		).toEqual(["blocked", "ordinary", "waiting"]);
	});
	it("prioritizes approval activity in In Progress", () => {
		expect(
			getCardAttention(card, "in_progress", {
				...summary,
				latestHookActivity: {
					activityText: "Waiting for approval",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: null,
					notificationType: null,
					source: null,
				},
			}),
		).toBe("approval");
		expect(getCardAttention(card, "in_progress", summary)).toBeNull();
	});
	it.each(["backlog", "trash"] as const)("leaves %s unchanged", (columnId) => {
		expect(getCardAttention(card, columnId, summary)).toBeNull();
	});
	it("sorts stably without mutating stored order", () => {
		const cards = [card, { ...card, id: "owner-a" }, { ...card, id: "owner-b" }];
		expect(sortCardsByAttention(cards, "review", { task: summary }).map(({ id }) => id)).toEqual([
			"owner-a",
			"owner-b",
			"task",
		]);
		expect(cards.map(({ id }) => id)).toEqual(["task", "owner-a", "owner-b"]);
	});
});
