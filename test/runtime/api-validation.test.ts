import { describe, expect, it } from "vitest";

import {
	runtimeBoardCardSchema,
	runtimeBoardColumnIdSchema,
	runtimeBoardDataSchema,
	runtimeTaskHandOffRequestSchema,
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

describe("agent review card fields", () => {
	const baseCard = { id: "a", prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };

	it("parses a card without the fields and leaves them absent", () => {
		const card = runtimeBoardCardSchema.parse(baseCard);
		expect(card.agentReviewEnabled).toBeUndefined();
		expect(card.reviewRound).toBeUndefined();
	});

	it("keeps agentReviewEnabled and reviewRound", () => {
		const card = runtimeBoardCardSchema.parse({ ...baseCard, agentReviewEnabled: true, reviewRound: 2 });
		expect(card.agentReviewEnabled).toBe(true);
		expect(card.reviewRound).toBe(2);
	});
});

describe("runtimeTaskHandOffRequestSchema", () => {
	it("rejects an empty reason", () => {
		expect(runtimeTaskHandOffRequestSchema.safeParse({ taskId: "task-1", reason: "" }).success).toBe(false);
	});
});

describe("legacy board compatibility", () => {
	const baseCard = { id: "a", prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };
	it("keeps legacy done→trash mapping", () => {
		expect(runtimeBoardColumnIdSchema.parse("done")).toBe("trash");
	});

	it("drops the legacy agentReview object and merges legacy cards into review", () => {
		const board = runtimeBoardDataSchema.parse({
			columns: [
				{ id: "review", title: "Review", cards: [baseCard] },
				{
					id: "user_review",
					title: "Needs your review",
					cards: [{ ...baseCard, id: "legacy", agentReviewEnabled: true, agentReview: { status: "passed" } }],
				},
			],
		});
		expect(board.columns).toHaveLength(1);
		expect(board.columns[0]?.id).toBe("review");
		expect(board.columns[0]?.cards.map(({ id }) => id)).toEqual(["a", "legacy"]);
		expect(board.columns[0]?.cards[1]?.agentReviewEnabled).toBe(true);
		expect(board.columns[0]?.cards[1]).not.toHaveProperty("agentReview");
	});
});
