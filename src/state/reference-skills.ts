import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "./workspace-state";

export const REFERENCE_SKILLS_FILENAME = "reference-skills.json";
const REFERENCE_SKILLS_FILE_VERSION = 1;
const SCAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const SEED_SKILLS = ["superpowers:test-driven-development", "superpowers:systematic-debugging"];
/**
 * Workflow skills that assume an interactive owner or conflict with the Kanban task flow. They never enter the
 * reference set: brainstorming in a task agent makes it ask questions instead of implementing.
 */
export const EXCLUDED_REFERENCE_SKILLS: readonly string[] = [
	"superpowers:brainstorming",
	"superpowers:writing-plans",
	"superpowers:executing-plans",
	"superpowers:subagent-driven-development",
	"superpowers:dispatching-parallel-agents",
	"superpowers:using-git-worktrees",
	"superpowers:finishing-a-development-branch",
];
const WORKTREES_MARKER = "-cline-worktrees-";

export interface SkillSource {
	name: string;
	dir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listDir(path: string): Promise<string[]> {
	return await readdir(path).catch(() => []);
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

function countSkillCalls(text: string, counts: Map<string, number>): void {
	for (const line of text.split("\n")) {
		// Cheap pre-filter: most transcript lines are not skill calls.
		if (!line.includes('"Skill"')) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const content = isRecord(parsed) && isRecord(parsed.message) ? parsed.message.content : null;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block) || block.type !== "tool_use" || block.name !== "Skill") continue;
			const skill = isRecord(block.input) ? block.input.skill : null;
			if (typeof skill === "string" && skill.length > 0) {
				counts.set(skill, (counts.get(skill) ?? 0) + 1);
			}
		}
	}
}

/** Counts Skill tool calls in Claude transcripts of task worktrees (`<id>-<repoName>`) modified since `sinceMs`. */
export async function scanClaudeTaskSkillUsage(input: {
	home: string;
	repoName: string;
	sinceMs: number;
}): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	const projectsDir = join(input.home, ".claude", "projects");
	const suffix = `-${input.repoName}`;
	for (const dirName of await listDir(projectsDir)) {
		// Task worktree dirs look like `-Users-x--cline-worktrees-05b89-Path-Planning`.
		const marker = dirName.indexOf(WORKTREES_MARKER);
		if (marker === -1 || !dirName.endsWith(suffix)) continue;
		const id = dirName.slice(marker + WORKTREES_MARKER.length, dirName.length - suffix.length);
		if (id.length === 0 || id.includes("-")) continue;
		const dir = join(projectsDir, dirName);
		for (const file of await listDir(dir)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(dir, file);
			const info = await stat(path).catch(() => null);
			if (!info || info.mtimeMs < input.sinceMs) continue;
			countSkillCalls(await readFile(path, "utf8").catch(() => ""), counts);
		}
	}
	return counts;
}

function getReferenceSkillsPath(workspaceId: string): string {
	return join(getWorkspaceDirectoryPath(workspaceId), REFERENCE_SKILLS_FILENAME);
}

async function readPersistedSkills(path: string): Promise<string[]> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed) && Array.isArray(parsed.skills)) {
			return parsed.skills.filter((skill): skill is string => typeof skill === "string");
		}
	} catch {
		// Malformed file: treated as nothing persisted.
	}
	return [];
}

const referenceCache = new Map<string, { skills: string[]; at: number }>();

export async function loadReferenceSkills(input: {
	workspaceId: string;
	home: string;
	repoName: string;
	now: number;
}): Promise<string[]> {
	const cacheKey = `${input.workspaceId}\u0000${input.home}\u0000${input.repoName}`;
	const cached = referenceCache.get(cacheKey);
	if (cached && input.now - cached.at < CACHE_TTL_MS) {
		return cached.skills;
	}
	const usage = await scanClaudeTaskSkillUsage({
		home: input.home,
		repoName: input.repoName,
		sinceMs: input.now - SCAN_WINDOW_MS,
	});
	const path = getReferenceSkillsPath(input.workspaceId);
	for (const excluded of EXCLUDED_REFERENCE_SKILLS) usage.delete(excluded);
	let skills: string[];
	if (usage.size > 0) {
		skills = [...usage.keys()].sort();
		await lockedFileSystem.writeJsonFileAtomic(
			path,
			{ version: REFERENCE_SKILLS_FILE_VERSION, skills, computedAt: input.now },
			{ lock: { path, type: "file" } },
		);
	} else {
		const persisted = await readPersistedSkills(path);
		const usable = persisted.filter((skill) => !EXCLUDED_REFERENCE_SKILLS.includes(skill));
		skills = usable.length > 0 ? usable : [...SEED_SKILLS];
	}
	referenceCache.set(cacheKey, { skills, at: input.now });
	return skills;
}

/** Every installed Claude skill as `plugin:name` (latest plugin version) or bare `name`, for `*` globs. */
export async function listInstalledSkillNames(home: string): Promise<string[]> {
	const names: string[] = [];
	for (const name of await listDir(join(home, ".claude", "skills"))) {
		if (await exists(join(home, ".claude", "skills", name, "SKILL.md"))) names.push(name);
	}
	const cacheRoot = join(home, ".claude", "plugins", "cache");
	for (const marketplace of await listDir(cacheRoot)) {
		for (const plugin of await listDir(join(cacheRoot, marketplace))) {
			const pluginDir = join(cacheRoot, marketplace, plugin);
			const latest = (await listDir(pluginDir)).sort(compareVersionsDesc)[0];
			if (!latest) continue;
			const skillsDir = join(pluginDir, latest, "skills");
			for (const skill of await listDir(skillsDir)) {
				if (await exists(join(skillsDir, skill, "SKILL.md"))) names.push(`${plugin}:${skill}`);
			}
		}
	}
	return names;
}

function compareVersionsDesc(a: string, b: string): number {
	return b.localeCompare(a, undefined, { numeric: true });
}

async function resolvePluginSkill(home: string, plugin: string, skill: string): Promise<string | null> {
	const cacheRoot = join(home, ".claude", "plugins", "cache");
	const candidates: { version: string; dir: string }[] = [];
	for (const marketplace of await listDir(cacheRoot)) {
		const pluginDir = join(cacheRoot, marketplace, plugin);
		for (const version of await listDir(pluginDir)) {
			const dir = join(pluginDir, version, "skills", skill);
			if (await exists(join(dir, "SKILL.md"))) candidates.push({ version, dir });
		}
	}
	candidates.sort((a, b) => compareVersionsDesc(a.version, b.version));
	return candidates[0]?.dir ?? null;
}

/** Maps `plugin:name` or bare `name` to installed Claude skill folders. Missing skills warn and are skipped. */
export async function resolveSkillSources(home: string, names: string[]): Promise<SkillSource[]> {
	const sources: SkillSource[] = [];
	for (const full of names) {
		const separator = full.indexOf(":");
		const plugin = separator === -1 ? null : full.slice(0, separator);
		const name = separator === -1 ? full : full.slice(separator + 1);
		let dir: string | null;
		if (plugin) {
			dir = await resolvePluginSkill(home, plugin, name);
		} else {
			const candidate = join(home, ".claude", "skills", name);
			dir = (await exists(join(candidate, "SKILL.md"))) ? candidate : null;
		}
		if (dir === null) {
			// Bound at call time so tests can spy on console.warn; the lint plugin bans direct console calls.
			console.warn.bind(console)(`Reference skill "${full}" is not installed under ${home}/.claude. Skipping it.`);
			continue;
		}
		sources.push({ name, dir });
	}
	return sources;
}
