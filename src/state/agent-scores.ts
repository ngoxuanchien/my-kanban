import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAgentScore } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

export const AGENT_SCORES_FILENAME = "agent-scores.json";
const AGENT_SCORES_FILE_VERSION = 1;

export type AgentScoreEventType = "assigned" | "pass" | "fail";

export interface AgentScoreEvent {
	type: AgentScoreEventType;
	agentId: string;
	taskId: string;
	round?: number;
	at: number;
}

export interface AgentScoreEventInput {
	type: AgentScoreEventType;
	agentId: string;
	taskId: string;
	round?: number;
}

interface AgentScoreEventFile {
	version: number;
	events: AgentScoreEvent[];
}

interface AgentScoreAccumulator {
	taskIds: Set<string>;
	passTaskIds: Set<string>;
	failTaskKeys: Set<string>;
}

function createAgentScoreAccumulator(): AgentScoreAccumulator {
	return {
		taskIds: new Set<string>(),
		passTaskIds: new Set<string>(),
		failTaskKeys: new Set<string>(),
	};
}

function isAgentScoreEventType(value: unknown): value is AgentScoreEventType {
	return value === "assigned" || value === "pass" || value === "fail";
}

function isAgentScoreEvent(value: unknown): value is AgentScoreEvent {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (!isAgentScoreEventType(candidate.type)) {
		return false;
	}
	if (typeof candidate.agentId !== "string" || typeof candidate.taskId !== "string") {
		return false;
	}
	const round = candidate.round;
	return round === undefined || typeof round === "number";
}

function getAgentScoreTaskKey(event: Pick<AgentScoreEvent, "type" | "agentId" | "taskId" | "round">): string {
	const taskKey = `${event.agentId}\u0000${event.taskId}`;
	if (event.type === "fail") {
		return `${taskKey}\u0000${event.round ?? ""}`;
	}
	return taskKey;
}

export function summarizeAgentScoreEvents(events: AgentScoreEvent[]): RuntimeAgentScore[] {
	const agents = new Map<string, AgentScoreAccumulator>();
	for (const event of events) {
		const agentId = event.agentId === "claude" ? "opus" : event.agentId;
		let accumulator = agents.get(agentId);
		if (!accumulator) {
			accumulator = createAgentScoreAccumulator();
			agents.set(agentId, accumulator);
		}
		if (event.type === "assigned") {
			accumulator.taskIds.add(event.taskId);
		} else if (event.type === "pass") {
			accumulator.passTaskIds.add(event.taskId);
		} else {
			accumulator.failTaskKeys.add(getAgentScoreTaskKey({ ...event, agentId }));
		}
	}

	const summaries: RuntimeAgentScore[] = [];
	for (const [agentId, accumulator] of agents) {
		const passes = accumulator.passTaskIds.size;
		const fails = accumulator.failTaskKeys.size;
		summaries.push({
			agentId,
			score: passes - fails,
			passes,
			fails,
			tasks: accumulator.taskIds.size,
		});
	}
	return summaries.sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));
}

const agentScoreEventWarn = console.warn.bind(console);

function warnMalformedAgentScoresFile(path: string): void {
	agentScoreEventWarn(`Malformed agent scores file at ${path}. Falling back to no events.`);
}

async function readAgentScoreEvents(path: string): Promise<AgentScoreEvent[]> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			warnMalformedAgentScoresFile(path);
			return [];
		}
		const file = parsed as Partial<AgentScoreEventFile>;
		if (!Array.isArray(file.events)) {
			warnMalformedAgentScoresFile(path);
			return [];
		}
		return file.events.filter(isAgentScoreEvent);
	} catch {
		warnMalformedAgentScoresFile(path);
		return [];
	}
}

function appendAgentScoreEvent(events: AgentScoreEvent[], event: AgentScoreEventInput, at: number): boolean {
	if (event.type === "assigned") {
		const alreadyAssigned = events.some(
			(existing) =>
				existing.type === "assigned" && existing.agentId === event.agentId && existing.taskId === event.taskId,
		);
		if (alreadyAssigned) {
			return false;
		}
		events.push({ type: "assigned", agentId: event.agentId, taskId: event.taskId, at });
		return true;
	}

	const hasAssigned = events.some(
		(existing) =>
			existing.type === "assigned" && existing.agentId === event.agentId && existing.taskId === event.taskId,
	);
	if (!hasAssigned) {
		events.push({ type: "assigned", agentId: event.agentId, taskId: event.taskId, at });
	}

	const alreadyRecorded = events.some(
		(existing) => existing.type === event.type && getAgentScoreTaskKey(existing) === getAgentScoreTaskKey(event),
	);
	if (alreadyRecorded) {
		return false;
	}
	events.push({ type: event.type, agentId: event.agentId, taskId: event.taskId, round: event.round, at });
	return true;
}

export async function recordAgentScoreEvent(
	workspaceId: string,
	event: AgentScoreEventInput,
	now: () => number = () => Date.now(),
): Promise<boolean> {
	const path = join(getWorkspaceDirectoryPath(workspaceId), AGENT_SCORES_FILENAME);
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const events = await readAgentScoreEvents(path);
		const appended = appendAgentScoreEvent(events, event, now());
		if (appended) {
			await lockedFileSystem.writeJsonFileAtomic(
				path,
				{
					version: AGENT_SCORES_FILE_VERSION,
					events,
				},
				{ lock: null },
			);
		}
		return appended;
	});
}

export async function loadAgentScores(workspaceId: string): Promise<RuntimeAgentScore[]> {
	const path = join(getWorkspaceDirectoryPath(workspaceId), AGENT_SCORES_FILENAME);
	const events = await readAgentScoreEvents(path);
	return summarizeAgentScoreEvents(events);
}
