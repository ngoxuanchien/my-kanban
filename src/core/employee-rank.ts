import type { EmployeeProfile } from "../state/employees";
import type { RuntimeBoardData } from "./api-contract";
import type { EmployeeArea } from "./employee-areas";

const OUT_OF_QUOTA_WINDOW_MS = 3_600_000;

export function outOfQuotaAgentIds(board: RuntimeBoardData, now: number): Set<string> {
	const ids = new Set<string>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			if (card.agentId && card.quotaBlockedAt !== undefined && now - card.quotaBlockedAt < OUT_OF_QUOTA_WINDOW_MS) {
				ids.add(card.agentId);
			}
		}
	}
	return ids;
}

export interface RankedEmployee {
	key: string;
	agentId: string;
	model: string | null;
	reason: string;
}

interface Scored {
	profile: EmployeeProfile;
	strongHits: EmployeeArea[];
	rate: number;
	reason: string;
}

function scoreProfile(profile: EmployeeProfile, areas: EmployeeArea[]): Scored {
	const strongHits = areas.filter((area) => profile.strong.includes(area));
	let rate = 0;
	let evidence: string | null = null;
	for (const area of areas) {
		const stats = profile.areas[area] ?? { passes: 0, fails: 0 };
		rate += (stats.passes + 1) / (stats.passes + stats.fails + 2);
		if (evidence === null && stats.passes + stats.fails > 0) {
			evidence = `${area} ${stats.passes}/${stats.fails}`;
		}
	}
	const reason = strongHits[0] ? `strong ${strongHits[0]}` : (evidence ?? `score ${profile.score.score}`);
	return { profile, strongHits, rate: Math.round(rate / 0.05), reason };
}

export function rankEmployees(input: {
	profiles: EmployeeProfile[];
	areas: EmployeeArea[];
	difficulty: number;
	outOfQuota: Set<string>;
	agentIds?: string[];
}): RankedEmployee[] {
	const eligible = input.profiles.filter(
		(profile) =>
			profile.status === "active" &&
			!input.outOfQuota.has(profile.agentId) &&
			!profile.avoid.some((area) => input.areas.includes(area)) &&
			(!input.agentIds || input.agentIds.includes(profile.agentId)),
	);
	const overall = (profile: EmployeeProfile): number =>
		input.difficulty >= 4 ? profile.score.passes : profile.score.score;
	return eligible
		.map((profile) => scoreProfile(profile, input.areas))
		.sort(
			(a, b) =>
				b.strongHits.length - a.strongHits.length ||
				b.rate - a.rate ||
				overall(b.profile) - overall(a.profile) ||
				a.profile.key.localeCompare(b.profile.key),
		)
		.map(({ profile, reason }) => ({ key: profile.key, agentId: profile.agentId, model: profile.model, reason }));
}
