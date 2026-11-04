import { z } from "zod";
import type { RuntimeAgentId, RuntimeBoardCard } from "./api-contract";
import { type RuntimeClaudeModel, runtimeClaudeModelSchema } from "./claude-model";

export const runtimeTaskDifficultySchema = z.union([
	z.literal(1),
	z.literal(2),
	z.literal(3),
	z.literal(4),
	z.literal(5),
]);
export type TaskDifficulty = z.infer<typeof runtimeTaskDifficultySchema>;

export const difficultyModelCellSchema = z.object({
	model: z.string().optional(),
	reasoningEffort: z.string().optional(),
});
export type DifficultyModelCell = z.infer<typeof difficultyModelCellSchema>;

const claudeDifficultyModelCellSchema = z.object({ model: runtimeClaudeModelSchema.optional() });

function difficultyRowsSchema<T extends z.ZodTypeAny>(cell: T) {
	return z.object({
		1: cell.optional(),
		2: cell.optional(),
		3: cell.optional(),
		4: cell.optional(),
		5: cell.optional(),
	});
}

export const difficultyModelMapSchema = z.object({
	codex: difficultyRowsSchema(difficultyModelCellSchema).optional(),
	opencode: difficultyRowsSchema(difficultyModelCellSchema).optional(),
	claude: difficultyRowsSchema(claudeDifficultyModelCellSchema).optional(),
});
export type DifficultyModelMap = z.infer<typeof difficultyModelMapSchema>;

export const DEFAULT_DIFFICULTY_MODEL_MAP: DifficultyModelMap = {
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
};

/** Invalid or missing stored maps fall back to the shipped defaults. */
export function normalizeDifficultyModelMap(value: unknown): DifficultyModelMap {
	const parsed = difficultyModelMapSchema.safeParse(value);
	return parsed.success ? parsed.data : DEFAULT_DIFFICULTY_MODEL_MAP;
}

export interface ResolvedTaskAgentModel {
	model: string | null;
	reasoningEffort: string | null;
	source: "card" | "difficulty" | "default";
}

const NO_OVERRIDE: ResolvedTaskAgentModel = { model: null, reasoningEffort: null, source: "default" };

/** Resolution order: explicit card model > difficulty table > agent default. */
export function resolveTaskAgentModel(input: {
	agentId: RuntimeAgentId;
	card: Pick<RuntimeBoardCard, "difficulty" | "agentModel" | "agentReasoningEffort" | "claudeModel">;
	map: DifficultyModelMap;
	claudeDefaultModel: RuntimeClaudeModel;
}): ResolvedTaskAgentModel {
	const { agentId, card, map } = input;
	if (agentId === "claude") {
		if (card.claudeModel) return { model: card.claudeModel, reasoningEffort: null, source: "card" };
		const cellModel = card.difficulty ? map.claude?.[card.difficulty]?.model : undefined;
		if (cellModel) return { model: cellModel, reasoningEffort: null, source: "difficulty" };
		return { model: input.claudeDefaultModel, reasoningEffort: null, source: "default" };
	}
	if (agentId !== "codex" && agentId !== "opencode") return NO_OVERRIDE;
	// Reasoning effort is a Codex-only setting.
	const explicitEffort = agentId === "codex" ? (card.agentReasoningEffort ?? null) : null;
	// Codex pair rule: an explicit model wins as a whole; the table is not consulted.
	if (card.agentModel) return { model: card.agentModel, reasoningEffort: explicitEffort, source: "card" };
	const cell = card.difficulty ? map[agentId]?.[card.difficulty] : undefined;
	if (!cell?.model) return NO_OVERRIDE;
	const tableEffort = agentId === "codex" ? (cell.reasoningEffort ?? null) : null;
	return { model: cell.model, reasoningEffort: explicitEffort ?? tableEffort, source: "difficulty" };
}
