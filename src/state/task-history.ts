import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

export const TASK_HISTORY_DIRNAME = "task-history";
const TASK_HISTORY_FILE_VERSION = 1;

export type TaskHistoryEventType = "started" | "fail" | "handoff" | "quota_blocked" | "retry" | "pass" | "session";

export interface AgentSessionRef {
	agentId: string;
	id?: string;
	transcriptPath?: string;
}

export interface TaskHistoryEvent {
	type: TaskHistoryEventType;
	agentId: string;
	at: number;
	round?: number;
	detail?: string;
	commit?: string;
	toAgentId?: string;
	agentSession?: AgentSessionRef;
}

interface TaskHistoryFile {
	version: number;
	events: TaskHistoryEvent[];
}

function getTaskHistoryPath(workspaceId: string, taskId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), TASK_HISTORY_DIRNAME, `${taskId}.json`);
}

const MAX_DETAIL_LENGTH = 20_000;
const TRUNCATED_SUFFIX = "… (truncated)";

function truncateDetail(detail: string | undefined): string | undefined {
	if (detail === undefined) {
		return undefined;
	}
	if (detail.length <= MAX_DETAIL_LENGTH) {
		return detail;
	}
	return `${detail.slice(0, MAX_DETAIL_LENGTH)}${TRUNCATED_SUFFIX}`;
}

function isTaskHistoryEventType(value: unknown): value is TaskHistoryEventType {
	return (
		value === "started" ||
		value === "fail" ||
		value === "handoff" ||
		value === "quota_blocked" ||
		value === "retry" ||
		value === "pass" ||
		value === "session"
	);
}

function isTaskHistoryEvent(value: unknown): value is TaskHistoryEvent {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	if (!isTaskHistoryEventType(candidate.type)) {
		return false;
	}
	if (typeof candidate.agentId !== "string" || typeof candidate.at !== "number") {
		return false;
	}
	if (candidate.round !== undefined && typeof candidate.round !== "number") {
		return false;
	}
	if (candidate.detail !== undefined && typeof candidate.detail !== "string") {
		return false;
	}
	if (candidate.commit !== undefined && typeof candidate.commit !== "string") {
		return false;
	}
	if (candidate.toAgentId !== undefined && typeof candidate.toAgentId !== "string") {
		return false;
	}
	if (candidate.agentSession !== undefined) {
		if (typeof candidate.agentSession !== "object" || candidate.agentSession === null) {
			return false;
		}
		const session = candidate.agentSession as Record<string, unknown>;
		if (typeof session.agentId !== "string") {
			return false;
		}
		if (session.id !== undefined && typeof session.id !== "string") {
			return false;
		}
		if (session.transcriptPath !== undefined && typeof session.transcriptPath !== "string") {
			return false;
		}
	}
	return true;
}

async function readTaskHistoryEvents(path: string): Promise<TaskHistoryEvent[]> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) {
			return [];
		}
		const file = parsed as Partial<TaskHistoryFile>;
		if (file.version !== TASK_HISTORY_FILE_VERSION || !Array.isArray(file.events)) {
			return [];
		}
		return file.events.filter(isTaskHistoryEvent);
	} catch {
		return [];
	}
}

function appendTaskHistoryEvent(events: TaskHistoryEvent[], input: Omit<TaskHistoryEvent, "at">, at: number): boolean {
	const truncatedDetail = truncateDetail(input.detail);

	if (input.type === "fail") {
		const existingFail = events.find((existing) => existing.type === "fail" && existing.round === input.round);
		if (existingFail) {
			if (!existingFail.detail && truncatedDetail) {
				existingFail.detail = truncatedDetail;
				return true;
			}
			return false;
		}
		const newEvent: TaskHistoryEvent = {
			type: "fail",
			agentId: input.agentId,
			round: input.round,
			at,
		};
		if (truncatedDetail !== undefined) newEvent.detail = truncatedDetail;
		if (input.toAgentId !== undefined) newEvent.toAgentId = input.toAgentId;
		events.push(newEvent);
		return true;
	}

	if (input.type === "pass") {
		const alreadyPassed = events.some((existing) => existing.type === "pass");
		if (alreadyPassed) {
			return false;
		}
		const newEvent: TaskHistoryEvent = {
			type: "pass",
			agentId: input.agentId,
			round: input.round,
			at,
		};
		if (input.commit !== undefined) newEvent.commit = input.commit;
		if (truncatedDetail !== undefined) newEvent.detail = truncatedDetail;
		events.push(newEvent);
		return true;
	}

	if (input.type === "session") {
		const sessionId = input.agentSession?.id;
		const isDuplicate =
			sessionId !== undefined &&
			events.some((existing) => existing.type === "session" && existing.agentSession?.id === sessionId);
		if (isDuplicate) {
			return false;
		}
	} else {
		const isDuplicate = events.some((existing) => {
			return (
				existing.type === input.type &&
				existing.agentId === input.agentId &&
				existing.round === input.round &&
				existing.detail === truncatedDetail &&
				existing.commit === input.commit &&
				existing.toAgentId === input.toAgentId &&
				JSON.stringify(existing.agentSession) === JSON.stringify(input.agentSession) &&
				Math.abs(at - existing.at) <= 5000
			);
		});
		if (isDuplicate) {
			return false;
		}
	}

	const newEvent: TaskHistoryEvent = {
		type: input.type,
		agentId: input.agentId,
		at,
	};
	if (input.round !== undefined) newEvent.round = input.round;
	if (truncatedDetail !== undefined) newEvent.detail = truncatedDetail;
	if (input.commit !== undefined) newEvent.commit = input.commit;
	if (input.toAgentId !== undefined) newEvent.toAgentId = input.toAgentId;
	if (input.agentSession !== undefined) newEvent.agentSession = input.agentSession;
	events.push(newEvent);
	return true;
}

export async function recordTaskHistoryEvent(
	workspaceId: string,
	taskId: string,
	event: Omit<TaskHistoryEvent, "at">,
	now: () => number = () => Date.now(),
): Promise<boolean> {
	const path = getTaskHistoryPath(workspaceId, taskId);
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const events = await readTaskHistoryEvents(path);
		const mutated = appendTaskHistoryEvent(events, event, now());
		if (mutated) {
			await lockedFileSystem.writeJsonFileAtomic(
				path,
				{
					version: TASK_HISTORY_FILE_VERSION,
					events,
				},
				{ lock: null },
			);
		}
		return mutated;
	});
}

export async function loadTaskHistory(workspaceId: string, taskId: string): Promise<TaskHistoryEvent[]> {
	const path = getTaskHistoryPath(workspaceId, taskId);
	const events = await readTaskHistoryEvents(path);
	return events.sort((a, b) => a.at - b.at);
}

export async function deleteTaskHistory(workspaceId: string, taskId: string): Promise<void> {
	const path = getTaskHistoryPath(workspaceId, taskId);
	await rm(path, { force: true });
}
