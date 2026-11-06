import type { RuntimeBoardCard } from "./api-contract";

export const HAND_OFF_CYCLE = ["codex", "opencode", "antigravity"] as const;
export type HandOffAgentId = (typeof HAND_OFF_CYCLE)[number];
export const MAX_HAND_OFFS = 2;

export function isHandOffAgentId(agentId: string | undefined): agentId is HandOffAgentId {
	return HAND_OFF_CYCLE.some((id) => id === agentId);
}

export function nextHandOffAgent(agentId: HandOffAgentId): HandOffAgentId {
	return HAND_OFF_CYCLE[(HAND_OFF_CYCLE.indexOf(agentId) + 1) % HAND_OFF_CYCLE.length] ?? HAND_OFF_CYCLE[0];
}

export function nextEligibleHandOffAgent(
	agentId: HandOffAgentId,
	eligible: (candidate: HandOffAgentId) => boolean,
): HandOffAgentId {
	const start = HAND_OFF_CYCLE.indexOf(agentId);
	for (let step = 1; step < HAND_OFF_CYCLE.length; step += 1) {
		const candidate = HAND_OFF_CYCLE[(start + step) % HAND_OFF_CYCLE.length];
		if (candidate && eligible(candidate)) return candidate;
	}
	return nextHandOffAgent(agentId);
}

export function handOffHistory(agentId: HandOffAgentId, handOffCount: number): HandOffAgentId[] {
	const currentIndex = HAND_OFF_CYCLE.indexOf(agentId);
	return Array.from(
		{ length: handOffCount + 1 },
		(_, index) =>
			HAND_OFF_CYCLE[(currentIndex - handOffCount + index + HAND_OFF_CYCLE.length) % HAND_OFF_CYCLE.length] ??
			HAND_OFF_CYCLE[0],
	);
}

export function getHandOffCount(card: Pick<RuntimeBoardCard, "handOffCount" | "handedOff">): number {
	return card.handOffCount ?? (card.handedOff === true ? 1 : 0);
}

export function getReviewRoundCap(card: Pick<RuntimeBoardCard, "handOffCount" | "handedOff">): number {
	return 3 * (getHandOffCount(card) + 1);
}
