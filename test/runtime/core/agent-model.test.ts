import { describe, expect, it } from "vitest";

import {
	DEFAULT_DIFFICULTY_MODEL_MAP,
	type DifficultyModelMap,
	normalizeDifficultyModelMap,
	resolveTaskAgentModel,
	runtimeTaskDifficultySchema,
} from "../../../src/core/agent-model";
import { runtimeBoardCardSchema } from "../../../src/core/api-contract";

const map = DEFAULT_DIFFICULTY_MODEL_MAP;

describe("resolveTaskAgentModel", () => {
	describe("claude", () => {
		it("uses the explicit card model first", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "claude",
					card: { claudeModel: "opus", difficulty: 1 },
					map,
					claudeDefaultModel: "sonnet",
				}),
			).toEqual({ model: "opus", reasoningEffort: null, source: "card" });
		});

		it("uses the difficulty table when no card model is set", () => {
			expect(
				resolveTaskAgentModel({ agentId: "claude", card: { difficulty: 2 }, map, claudeDefaultModel: "opus" }),
			).toEqual({ model: "haiku", reasoningEffort: null, source: "difficulty" });
		});

		it("falls back to claudeDefaultModel without difficulty or cell", () => {
			expect(resolveTaskAgentModel({ agentId: "claude", card: {}, map, claudeDefaultModel: "sonnet" })).toEqual({
				model: "sonnet",
				reasoningEffort: null,
				source: "default",
			});
			expect(
				resolveTaskAgentModel({ agentId: "claude", card: { difficulty: 3 }, map: {}, claudeDefaultModel: "opus" }),
			).toEqual({ model: "opus", reasoningEffort: null, source: "default" });
		});
	});

	describe("codex", () => {
		it("explicit agentModel without effort wins as a whole and ignores the table", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "codex",
					card: { agentModel: "gpt-5.6-terra", difficulty: 5 },
					map,
					claudeDefaultModel: "opus",
				}),
			).toEqual({ model: "gpt-5.6-terra", reasoningEffort: null, source: "card" });
		});

		it("explicit agentModel keeps its explicit effort", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "codex",
					card: { agentModel: "gpt-5.6-terra", agentReasoningEffort: "xhigh", difficulty: 1 },
					map,
					claudeDefaultModel: "opus",
				}),
			).toEqual({ model: "gpt-5.6-terra", reasoningEffort: "xhigh", source: "card" });
		});

		it("uses the table model and effort when no explicit model is set", () => {
			expect(
				resolveTaskAgentModel({ agentId: "codex", card: { difficulty: 4 }, map, claudeDefaultModel: "opus" }),
			).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high", source: "difficulty" });
		});

		it("explicit agentReasoningEffort replaces the table effort", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "codex",
					card: { difficulty: 3, agentReasoningEffort: "max" },
					map,
					claudeDefaultModel: "opus",
				}),
			).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "max", source: "difficulty" });
		});

		it("records no override without difficulty or cell", () => {
			const none = { model: null, reasoningEffort: null, source: "default" };
			expect(resolveTaskAgentModel({ agentId: "codex", card: {}, map, claudeDefaultModel: "opus" })).toEqual(none);
			expect(
				resolveTaskAgentModel({ agentId: "codex", card: { difficulty: 3 }, map: {}, claudeDefaultModel: "opus" }),
			).toEqual(none);
		});
	});

	describe("opencode", () => {
		const opencodeMap: DifficultyModelMap = { opencode: { 2: { model: "opencode/big-pickle" } } };

		it("uses the explicit card model first, never an effort", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "opencode",
					card: { agentModel: "opencode/beam-free", agentReasoningEffort: "high", difficulty: 2 },
					map: opencodeMap,
					claudeDefaultModel: "opus",
				}),
			).toEqual({ model: "opencode/beam-free", reasoningEffort: null, source: "card" });
		});

		it("uses the difficulty table when no card model is set", () => {
			expect(
				resolveTaskAgentModel({
					agentId: "opencode",
					card: { difficulty: 2 },
					map: opencodeMap,
					claudeDefaultModel: "opus",
				}),
			).toEqual({ model: "opencode/big-pickle", reasoningEffort: null, source: "difficulty" });
		});

		it("records no override with the shipped (empty) table", () => {
			expect(
				resolveTaskAgentModel({ agentId: "opencode", card: { difficulty: 5 }, map, claudeDefaultModel: "opus" }),
			).toEqual({ model: null, reasoningEffort: null, source: "default" });
		});
	});

	it("records no override for agents without model choice", () => {
		expect(
			resolveTaskAgentModel({
				agentId: "antigravity",
				card: { agentModel: "x", difficulty: 5 },
				map,
				claudeDefaultModel: "opus",
			}),
		).toEqual({ model: null, reasoningEffort: null, source: "default" });
	});
});

describe("DEFAULT_DIFFICULTY_MODEL_MAP", () => {
	it("equals the shipped defaults verbatim", () => {
		expect(DEFAULT_DIFFICULTY_MODEL_MAP).toEqual({
			codex: {
				1: { model: "gpt-6-luna", reasoningEffort: "low" },
				2: { model: "gpt-6-luna", reasoningEffort: "low" },
				3: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
				4: { model: "gpt-6.1-sol", reasoningEffort: "high" },
				5: { model: "gpt-6-astra", reasoningEffort: "high" },
			},
			opencode: {},
			claude: {
				1: { model: "haiku" },
				2: { model: "haiku" },
				3: { model: "sonnet" },
				4: { model: "sonnet" },
				5: { model: "opus" },
			},
		});
	});

	it("is used when a stored map is missing or invalid", () => {
		expect(normalizeDifficultyModelMap(undefined)).toEqual(DEFAULT_DIFFICULTY_MODEL_MAP);
		expect(normalizeDifficultyModelMap({ claude: { 1: { model: "gpt" } } })).toEqual(DEFAULT_DIFFICULTY_MODEL_MAP);
	});
});

describe("task difficulty schema", () => {
	const baseCard = { id: "t1", prompt: "p", startInPlanMode: false, baseRef: "main", createdAt: 1, updatedAt: 1 };

	it.each([0, 6, 2.5, "3"])("rejects %s", (value) => {
		expect(runtimeTaskDifficultySchema.safeParse(value).success).toBe(false);
		expect(runtimeBoardCardSchema.safeParse({ ...baseCard, difficulty: value }).success).toBe(false);
	});

	it("accepts 1-5 and keeps the new card fields", () => {
		const card = runtimeBoardCardSchema.parse({
			...baseCard,
			difficulty: 3,
			agentModel: "gpt-6.1-sol",
			agentReasoningEffort: "high",
		});
		expect(card).toMatchObject({ difficulty: 3, agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" });
	});
});
