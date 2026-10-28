import type { RuntimeAgentId, RuntimeReviewerAgentSetting } from "../core/api-contract";

const CROSS_REVIEWER_MAP = {
	opencode: "codex",
	codex: "opencode",
} as const satisfies Partial<Record<RuntimeAgentId, RuntimeAgentId>>;

export function resolveReviewerAgentId(
	setting: RuntimeReviewerAgentSetting,
	taskAgentId: RuntimeAgentId,
): RuntimeAgentId {
	if (setting === "same_as_task") {
		return taskAgentId;
	}
	if (setting === "cross") {
		const mapped = CROSS_REVIEWER_MAP[taskAgentId as keyof typeof CROSS_REVIEWER_MAP];
		if (mapped) {
			return mapped;
		}
		return taskAgentId;
	}
	return setting;
}
