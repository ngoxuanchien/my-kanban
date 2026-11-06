import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeAgentScore } from "../core/api-contract";
import { areasOfFiles, type EmployeeArea, isEmployeeArea } from "../core/employee-areas";
import { lockedFileSystem } from "../fs/locked-file-system";
import { runGit } from "../workspace/git-utils";
import { type AgentScoreEvent, loadAgentScoreEvents, summarizeAgentScoreEvents } from "./agent-scores";
import { loadTaskHistory } from "./task-history";
import { getWorkspaceDirectoryPath } from "./workspace-state";

export const EMPLOYEES_FILENAME = "employees.json";
const EMPLOYEES_FILE_VERSION = 1;
const CLAUDE_MODEL_KEYS = new Set(["opus", "sonnet", "haiku"]);

export function parseEmployeeKey(key: string): { agentId: string; model: string | null } {
	if (CLAUDE_MODEL_KEYS.has(key)) {
		return { agentId: "claude", model: key };
	}
	const separator = key.indexOf(":");
	if (separator === -1) {
		return { agentId: key, model: null };
	}
	return { agentId: key.slice(0, separator), model: key.slice(separator + 1) };
}

export interface DeclaredEmployee {
	status: "active" | "inactive";
	strong: EmployeeArea[];
	avoid: EmployeeArea[];
	notes: string;
	/** Extra skills for this employee, on top of the reference set. A trailing `*` is a prefix glob. */
	skills: string[];
	/** Extra MCP server names kept on for this employee, on top of the ones it used. */
	mcp: string[];
}

export interface EmployeeProfile {
	key: string;
	agentId: string;
	model: string | null;
	status: "active" | "inactive";
	strong: EmployeeArea[];
	avoid: EmployeeArea[];
	notes: string;
	score: RuntimeAgentScore;
	areas: Partial<Record<EmployeeArea, { passes: number; fails: number }>>;
}

function getEmployeesPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), EMPLOYEES_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAreaList(value: unknown): EmployeeArea[] {
	return Array.isArray(value)
		? value.filter((v): v is EmployeeArea => typeof v === "string" && isEmployeeArea(v))
		: [];
}

function toStringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

function toDeclared(value: unknown): DeclaredEmployee {
	const raw = isRecord(value) ? value : {};
	return {
		status: raw.status === "inactive" ? "inactive" : "active",
		strong: toAreaList(raw.strong),
		avoid: toAreaList(raw.avoid),
		notes: typeof raw.notes === "string" ? raw.notes : "",
		skills: toStringList(raw.skills),
		mcp: toStringList(raw.mcp),
	};
}

/** Returns the parsed file object, or null when missing or malformed (warns when malformed). */
async function readEmployeesFile(path: string): Promise<Record<string, unknown> | null> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed) && isRecord(parsed.employees)) {
			return parsed;
		}
	} catch {
		// fall through to the warning
	}
	// Bound at call time so tests can spy on console.warn; the lint plugin bans direct console calls.
	console.warn.bind(console)(`Malformed employees file at ${path}. Falling back to default profiles.`);
	return null;
}

export async function loadDeclaredEmployees(workspaceId: string): Promise<Record<string, DeclaredEmployee>> {
	const file = await readEmployeesFile(getEmployeesPath(workspaceId));
	const employees = file && isRecord(file.employees) ? file.employees : {};
	const result: Record<string, DeclaredEmployee> = {};
	for (const [key, value] of Object.entries(employees)) {
		result[key] = toDeclared(value);
	}
	return result;
}

export async function updateDeclaredEmployee(
	workspaceId: string,
	key: string,
	patch: Partial<DeclaredEmployee>,
): Promise<DeclaredEmployee> {
	const path = getEmployeesPath(workspaceId);
	return await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const file = (await readEmployeesFile(path)) ?? {};
		const employees = isRecord(file.employees) ? file.employees : {};
		const rawEntry = isRecord(employees[key]) ? employees[key] : {};
		const next: DeclaredEmployee = { ...toDeclared(rawEntry), ...patch };
		await lockedFileSystem.writeJsonFileAtomic(
			path,
			{ ...file, version: EMPLOYEES_FILE_VERSION, employees: { ...employees, [key]: { ...rawEntry, ...next } } },
			{ lock: null },
		);
		return next;
	});
}

const taskAreasCache = new Map<string, EmployeeArea[]>();

async function resolveTaskAreas(workspaceId: string, repoPath: string, taskId: string): Promise<EmployeeArea[] | null> {
	const cacheKey = `${workspaceId}\u0000${repoPath}\u0000${taskId}`;
	const cached = taskAreasCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const history = await loadTaskHistory(workspaceId, taskId);
	const commit = history.find((event) => event.type === "pass" && event.commit)?.commit;
	if (!commit) {
		return null;
	}
	// runGit strips inherited GIT_DIR/GIT_INDEX_FILE (set when a git hook runs the tests).
	const result = await runGit(repoPath, ["diff-tree", "--no-commit-id", "--root", "-r", "--name-only", commit]);
	if (!result.ok) {
		// Commit no longer exists (e.g. rebased away): areas unknown, score still counts.
		return null;
	}
	const areas = areasOfFiles(result.stdout.split("\n").filter((line) => line.length > 0));
	taskAreasCache.set(cacheKey, areas);
	return areas;
}

function normalizeKey(agentId: string): string {
	return agentId === "claude" ? "opus" : agentId;
}

export async function loadEmployeeProfiles(input: {
	workspaceId: string;
	repoPath: string;
}): Promise<EmployeeProfile[]> {
	const [events, declared] = await Promise.all([
		loadAgentScoreEvents(input.workspaceId),
		loadDeclaredEmployees(input.workspaceId),
	]);
	const eventsByKey = new Map<string, AgentScoreEvent[]>();
	for (const event of events) {
		const key = normalizeKey(event.agentId);
		const group = eventsByKey.get(key);
		if (group) group.push(event);
		else eventsByKey.set(key, [event]);
	}
	for (const key of Object.keys(declared)) {
		if (!eventsByKey.has(key)) eventsByKey.set(key, []);
	}

	const profiles: EmployeeProfile[] = [];
	for (const [key, group] of eventsByKey) {
		const score = summarizeAgentScoreEvents(group)[0] ?? { agentId: key, score: 0, passes: 0, fails: 0, tasks: 0 };
		const areas: EmployeeProfile["areas"] = {};
		const seen = new Set<string>();
		for (const event of group) {
			if (event.type === "assigned") continue;
			const dedupe = `${event.type}\u0000${event.taskId}\u0000${event.type === "fail" ? (event.round ?? "") : ""}`;
			if (seen.has(dedupe)) continue;
			seen.add(dedupe);
			const taskAreas = await resolveTaskAreas(input.workspaceId, input.repoPath, event.taskId);
			for (const area of taskAreas ?? []) {
				const stats = areas[area] ?? { passes: 0, fails: 0 };
				if (event.type === "pass") stats.passes += 1;
				else stats.fails += 1;
				areas[area] = stats;
			}
		}
		profiles.push({
			key,
			...parseEmployeeKey(key),
			...toDeclared(declared[key]),
			score: { ...score, agentId: key },
			areas,
		});
	}
	return profiles.sort((a, b) => a.key.localeCompare(b.key));
}
