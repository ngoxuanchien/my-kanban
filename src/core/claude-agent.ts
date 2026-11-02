import { z } from "zod";

export const runtimeClaudeAgentSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export function isRuntimeClaudeAgent(value: unknown): value is string {
	return runtimeClaudeAgentSchema.safeParse(value).success;
}

export function readCliAgentOption(args: readonly string[]): string | null {
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--agent") {
			const value = args[index + 1];
			return typeof value === "string" ? value : null;
		}
		if (arg?.startsWith("--agent=")) {
			return arg.slice("--agent=".length);
		}
	}
	return null;
}
