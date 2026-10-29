export function resolveEffectiveTaskAgentId(
	cardAgentId: string | null | undefined,
	sessionAgentId: string | null | undefined,
	defaultAgentId: string | null | undefined,
): string | null {
	return cardAgentId ?? sessionAgentId ?? defaultAgentId ?? null;
}
