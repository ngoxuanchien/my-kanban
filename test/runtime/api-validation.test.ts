import { describe, expect, it } from "vitest";

import {
	type RuntimeAgentReviewState,
	runtimeAgentReviewStateSchema,
	runtimeBoardCardSchema,
	runtimeBoardColumnIdSchema,
} from "../../src/core/api-contract";
import {
	parseHookIngestRequest,
	parseTaskSessionStartRequest,
	parseWorkspaceFileSearchRequest,
} from "../../src/core/api-validation";

describe("parseWorkspaceFileSearchRequest", () => {
	it("parses q and limit", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "  src/runtime ", limit: "25" }));
		expect(parsed).toEqual({
			query: "src/runtime",
			limit: 25,
		});
	});

	it("treats missing q as empty query", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ limit: "10" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("does not accept legacy query alias", () => {
		const parsed = parseWorkspaceFileSearchRequest(new URLSearchParams({ query: "legacy" }));
		expect(parsed).toEqual({
			query: "",
		});
	});

	it("throws when limit is invalid", () => {
		expect(() => {
			parseWorkspaceFileSearchRequest(new URLSearchParams({ q: "board", limit: "0" }));
		}).toThrow("Invalid file search limit parameter.");
	});
});

describe("parseHookIngestRequest", () => {
	it("parses and trims task and workspace identifiers", () => {
		const parsed = parseHookIngestRequest({
			taskId: "  task-123  ",
			workspaceId: "  workspace-456  ",
			event: "to_review",
			metadata: {
				source: " claude ",
				activityText: " Using Read ",
			},
		});
		expect(parsed).toEqual({
			taskId: "task-123",
			workspaceId: "workspace-456",
			event: "to_review",
			metadata: {
				source: "claude",
				activityText: "Using Read",
				hookEventName: undefined,
				toolName: undefined,
				finalMessage: undefined,
				notificationType: undefined,
			},
		});
	});

	it("throws when workspaceId is missing", () => {
		expect(() => {
			parseHookIngestRequest({
				taskId: "task-1",
				workspaceId: "   ",
				event: "to_review",
			});
		}).toThrow("Missing workspaceId");
	});
});

describe("parseTaskSessionStartRequest", () => {
	it("parses resumeFromTrash and trims task identifiers", () => {
		const parsed = parseTaskSessionStartRequest({
			taskId: "  task-1  ",
			prompt: "",
			baseRef: "  main  ",
			resumeFromTrash: true,
		});
		expect(parsed).toEqual({
			taskId: "task-1",
			prompt: "",
			baseRef: "main",
			resumeFromTrash: true,
		});
	});
});

describe("agent review contract", () => {
	const baseCard = { id: "a", prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
	const validState: RuntimeAgentReviewState = {
		status: "needs_user",
		round: 2,
		reason: "round_limit",
		reasonDetail: null,
		fingerprint: "abc",
		lastResult: {
			verdict: "fail",
			appVerified: true,
			appCheck: "ran the app",
			tests: [{ command: "npm test", result: "1 failed" }],
			summary: null,
			fixPrompt: "fix the failing test",
			notes: null,
		},
		fixPrompts: ["first fix", "second fix"],
		summary: {
			whatWasDone: "a",
			whatItAffects: "b",
			againstRequest: "c",
			howVerified: "d",
			risks: "e",
		},
		meta: { commitHash: null, prUrl: null, rounds: 2, reviewerAgentId: "codex", reviewedAt: 5 },
		updatedAt: 10,
	};

	it("parses user_review column and keeps legacy done→trash mapping", () => {
		expect(runtimeBoardColumnIdSchema.parse("user_review")).toBe("user_review");
		expect(runtimeBoardColumnIdSchema.parse("done")).toBe("trash");
	});

	it("loads a card without agent review fields as off", () => {
		const card = runtimeBoardCardSchema.parse(baseCard);
		expect(card.agentReviewEnabled).toBeUndefined();
		expect(card.agentReview).toBeUndefined();
	});

	it("round-trips a card with agentReview state", () => {
		const card = runtimeBoardCardSchema.parse({ ...baseCard, agentReviewEnabled: true, agentReview: validState });
		expect(card.agentReviewEnabled).toBe(true);
		expect(card.agentReview).toEqual(validState);
	});

	it("rejects agentReview with negative round", () => {
		expect(() => runtimeAgentReviewStateSchema.parse({ ...validState, round: -1 })).toThrow();
	});
});
