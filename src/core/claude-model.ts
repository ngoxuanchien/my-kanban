import { z } from "zod";

export const runtimeClaudeModelSchema = z.enum(["haiku", "sonnet", "opus"]);
export type RuntimeClaudeModel = z.infer<typeof runtimeClaudeModelSchema>;
export const DEFAULT_CLAUDE_MODEL: RuntimeClaudeModel = "opus";

export function isRuntimeClaudeModel(value: unknown): value is RuntimeClaudeModel {
	return value === "haiku" || value === "sonnet" || value === "opus";
}

export function resolveEffectiveClaudeModel(
	cardModel: RuntimeClaudeModel | undefined,
	defaultModel: RuntimeClaudeModel | undefined,
): RuntimeClaudeModel {
	return cardModel ?? defaultModel ?? DEFAULT_CLAUDE_MODEL;
}

export function resolveScoreAgentKey(input: {
	agentId: string;
	sessionClaudeModel?: string | null;
	cardClaudeModel?: RuntimeClaudeModel;
	defaultClaudeModel?: RuntimeClaudeModel;
}): string {
	if (input.agentId !== "claude") return input.agentId;
	if (input.sessionClaudeModel !== undefined)
		return isRuntimeClaudeModel(input.sessionClaudeModel) ? input.sessionClaudeModel : "claude";
	return resolveEffectiveClaudeModel(input.cardClaudeModel, input.defaultClaudeModel);
}

export function readCliModelOption(args: readonly string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--model") {
			const value = args[index + 1];
			return typeof value === "string" ? value : null;
		}
		if (arg?.startsWith("--model=")) {
			return arg.slice("--model=".length);
		}
	}
	return null;
}
