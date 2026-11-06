import type { Command } from "commander";
import { areasOfFiles, EMPLOYEE_AREAS, type EmployeeArea, isEmployeeArea } from "../core/employee-areas";
import { outOfQuotaAgentIds, rankEmployees } from "../core/employee-rank";
import { HAND_OFF_CYCLE } from "../core/hand-off-cap";
import { resolveProjectInputPath } from "../projects/project-path";
import {
	type DeclaredEmployee,
	type EmployeeProfile,
	loadEmployeeProfiles,
	updateDeclaredEmployee,
} from "../state/employees";
import { loadWorkspaceBoardById, loadWorkspaceContext } from "../state/workspace-state";

const EMPLOYEE_STATUSES = ["active", "inactive"] as const;
const NO_DATA_MESSAGE = "no data: use the rotation rule";
const MAX_RANK_LINES = 5;

class EmployeeInputError extends Error {}

interface ProjectOption {
	projectPath?: string;
}

function parseCsv(value: string): string[] {
	return value
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function parseAreas(flag: string, value: string): EmployeeArea[] {
	const areas = parseCsv(value);
	const invalid = areas.filter((area) => !isEmployeeArea(area));
	if (invalid.length > 0) {
		throw new EmployeeInputError(
			`Invalid area for ${flag}: ${invalid.join(", ")}. Valid areas: ${EMPLOYEE_AREAS.join(", ")}.`,
		);
	}
	return areas.filter(isEmployeeArea);
}

function parseStatus(value: string): DeclaredEmployee["status"] {
	const status = EMPLOYEE_STATUSES.find((candidate) => candidate === value);
	if (!status) {
		throw new EmployeeInputError(`Invalid status "${value}". Valid statuses: ${EMPLOYEE_STATUSES.join(", ")}.`);
	}
	return status;
}

function parseDifficulty(value: string): number {
	const difficulty = Number(value);
	if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
		throw new EmployeeInputError(`Invalid difficulty "${value}". Expected an integer from 1 to 5.`);
	}
	return difficulty;
}

async function resolveWorkspace(options: ProjectOption) {
	const cwd = process.cwd();
	const projectPath = (options.projectPath ?? "").trim();
	return await loadWorkspaceContext(projectPath ? resolveProjectInputPath(projectPath, cwd) : cwd, {
		autoCreateIfMissing: true,
	});
}

function formatProfileLine(profile: EmployeeProfile): string {
	const topAreas = Object.entries(profile.areas)
		.map(([area, stats]) => ({ area, passes: stats.passes, fails: stats.fails }))
		.sort((a, b) => b.passes + b.fails - (a.passes + a.fails) || a.area.localeCompare(b.area))
		.slice(0, 3)
		.map((entry) => `${entry.area} ${entry.passes}/${entry.fails}`)
		.join(", ");
	const tags = [...profile.strong.map((area) => `+${area}`), ...profile.avoid.map((area) => `-${area}`)];
	return [
		profile.key,
		profile.status,
		`s${profile.score.score} ${profile.score.passes}/${profile.score.fails}`,
		topAreas,
		tags.join(" "),
	]
		.filter((part) => part.length > 0)
		.join("  ");
}

async function runEmployeeCommand(handler: () => Promise<void>): Promise<void> {
	try {
		await handler();
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

export function registerEmployeeCommand(program: Command): void {
	const employee = program.command("employee").description("Inspect and rank agent+model employees.");
	const projectPathDescription = "Workspace path. Defaults to current directory workspace.";

	employee
		.command("list")
		.description("List employee profiles, one line each.")
		.option("--project-path <path>", projectPathDescription)
		.action(async (options: ProjectOption) => {
			await runEmployeeCommand(async () => {
				const context = await resolveWorkspace(options);
				const profiles = await loadEmployeeProfiles(context);
				const text = profiles.map(formatProfileLine).join("\n");
				process.stdout.write(text ? `${text}\n` : "no employees\n");
			});
		});

	employee
		.command("show")
		.description("Print one employee profile as JSON.")
		.requiredOption("--employee <key>", "Employee key, e.g. codex:gpt-5, opencode, opus.")
		.option("--project-path <path>", projectPathDescription)
		.action(async (options: ProjectOption & { employee: string }) => {
			await runEmployeeCommand(async () => {
				const context = await resolveWorkspace(options);
				const profile = (await loadEmployeeProfiles(context)).find((entry) => entry.key === options.employee);
				if (!profile) {
					throw new EmployeeInputError(`Unknown employee "${options.employee}".`);
				}
				process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
			});
		});

	employee
		.command("set")
		.description("Declare status, strong/avoid areas or notes for an employee.")
		.requiredOption("--employee <key>", "Employee key, e.g. codex:gpt-5, opencode, opus.")
		.option("--status <status>", `Status: ${EMPLOYEE_STATUSES.join(" | ")}.`)
		.option("--strong <areas>", "Comma-separated areas this employee is strong in.")
		.option("--avoid <areas>", "Comma-separated areas to avoid for this employee.")
		.option("--notes <text>", "Free-text notes.")
		.option("--project-path <path>", projectPathDescription)
		.action(
			async (
				options: ProjectOption & {
					employee: string;
					status?: string;
					strong?: string;
					avoid?: string;
					notes?: string;
				},
			) => {
				await runEmployeeCommand(async () => {
					// Validate everything before touching the workspace or the file.
					const patch: Partial<DeclaredEmployee> = {};
					if (options.status !== undefined) patch.status = parseStatus(options.status);
					if (options.strong !== undefined) patch.strong = parseAreas("--strong", options.strong);
					if (options.avoid !== undefined) patch.avoid = parseAreas("--avoid", options.avoid);
					if (options.notes !== undefined) patch.notes = options.notes;
					const context = await resolveWorkspace(options);
					const updated = await updateDeclaredEmployee(context.workspaceId, options.employee, patch);
					process.stdout.write(`${JSON.stringify({ employee: options.employee, ...updated }, null, 2)}\n`);
				});
			},
		);

	employee
		.command("rank")
		.description("Rank employees for the given areas or files (max 5 lines).")
		.option("--area <areas>", "Comma-separated areas.")
		.option("--files <paths>", "Comma-separated file paths; areas are derived from them.")
		.requiredOption("--difficulty <n>", "Task difficulty 1-5.")
		.option(
			"--all-agents",
			`Also rank agents outside ${HAND_OFF_CYCLE.join("/")} (e.g. Claude). Only when the user asks.`,
		)
		.option("--project-path <path>", projectPathDescription)
		.action(
			async (
				options: ProjectOption & { area?: string; files?: string; difficulty: string; allAgents?: boolean },
			) => {
				await runEmployeeCommand(async () => {
					const difficulty = parseDifficulty(options.difficulty);
					if (options.area === undefined && options.files === undefined) {
						throw new EmployeeInputError("Pass --area <areas> or --files <paths>.");
					}
					const areas = [
						...new Set([
							...(options.area !== undefined ? parseAreas("--area", options.area) : []),
							...(options.files !== undefined ? areasOfFiles(parseCsv(options.files)) : []),
						]),
					];
					const context = await resolveWorkspace(options);
					const [profiles, board] = await Promise.all([
						loadEmployeeProfiles(context),
						loadWorkspaceBoardById(context.workspaceId),
					]);
					const ranked = rankEmployees({
						profiles,
						areas,
						difficulty,
						outOfQuota: outOfQuotaAgentIds(board, Date.now()),
						agentIds: options.allAgents ? undefined : [...HAND_OFF_CYCLE],
					}).slice(0, MAX_RANK_LINES);
					if (ranked.length === 0) {
						process.stdout.write(`${NO_DATA_MESSAGE}\n`);
						return;
					}
					const lines = ranked.map(
						(entry) =>
							`${entry.key}  ${entry.reason}  --agent-id ${entry.agentId}${entry.model ? ` --model ${entry.model}` : ""}`,
					);
					process.stdout.write(`${lines.join("\n")}\n`);
				});
			},
		);
}
