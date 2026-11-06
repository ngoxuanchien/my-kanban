import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EXCLUDED_REFERENCE_SKILLS,
	listInstalledSkillNames,
	loadReferenceSkills,
	resolveSkillSources,
	scanClaudeTaskSkillUsage,
} from "../../../src/state/reference-skills";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

async function withTemporaryHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const { path: home, cleanup } = createTempDir("kanban-reference-skills-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return await run(home);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		cleanup();
	}
}

function skillLine(skill: string): string {
	return JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
	});
}

function writeTranscript(home: string, dirName: string, skills: string[], ageMs = 0): void {
	const dir = join(home, ".claude", "projects", dirName);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${skills.map(skillLine).join("\n")}\n{"type":"user","message":{"content":"Skill"}}\n`);
	const when = new Date(Date.now() - ageMs);
	utimesSync(file, when, when);
}

function installPluginSkill(home: string, plugin: string, version: string, skill: string): string {
	const dir = join(home, ".claude", "plugins", "cache", "market", plugin, version, "skills", skill);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: x\n---\n");
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("scanClaudeTaskSkillUsage", () => {
	it("counts task worktree transcripts of the repo only and ignores old files", async () => {
		await withTemporaryHome(async (home) => {
			writeTranscript(home, "-Users-x--cline-worktrees-ab123-my-kanban", [
				"superpowers:tdd",
				"superpowers:tdd",
				"graphify",
			]);
			writeTranscript(home, "-Users-x--cline-worktrees-cd456-other-repo", ["other:skill"]);
			writeTranscript(home, "-Users-x-Project-my-kanban", ["main:checkout"]);
			writeTranscript(home, "-Users-x--cline-worktrees-ef789-my-kanban", ["old:skill"], 40 * DAY_MS);
			const usage = await scanClaudeTaskSkillUsage({
				home,
				repoName: "my-kanban",
				sinceMs: Date.now() - 30 * DAY_MS,
			});
			expect(Object.fromEntries(usage)).toEqual({ "superpowers:tdd": 2, graphify: 1 });
		});
	});
});

describe("loadReferenceSkills", () => {
	const workspace = (suffix: string) => `reference-skills-${suffix}-${process.pid}`;

	it("persists a non-empty scan and falls back to it when a later scan is empty", async () => {
		await withTemporaryHome(async (home) => {
			const workspaceId = workspace("persist");
			writeTranscript(home, "-Users-x--cline-worktrees-ab123-my-kanban", [
				"superpowers:verification-before-completion",
			]);
			const first = await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now: Date.now() });
			expect(first).toEqual(["superpowers:verification-before-completion"]);
			// Cache expired and the transcript is now older than the 30-day window.
			const later = Date.now() + 2 * HOUR_MS + 40 * DAY_MS;
			const second = await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now: later });
			expect(second).toEqual(["superpowers:verification-before-completion"]);
		});
	});

	it("drops interactive workflow skills before persisting and from old persisted lists", async () => {
		await withTemporaryHome(async (home) => {
			const workspaceId = workspace("exclude");
			const dir = "-Users-x--cline-worktrees-ab123-my-kanban";
			writeTranscript(home, dir, [...EXCLUDED_REFERENCE_SKILLS, "superpowers:test-driven-development"]);
			const now = Date.now();
			expect(await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now })).toEqual([
				"superpowers:test-driven-development",
			]);
			const persisted = JSON.parse(
				readFileSync(join(getWorkspaceDirectoryPath(workspaceId), "reference-skills.json"), "utf8"),
			);
			expect(persisted.skills).toEqual(["superpowers:test-driven-development"]);
			// Only excluded skills used: falls back to the seed, not to an empty or excluded set.
			const other = workspace("exclude-only");
			writeTranscript(home, "-Users-x--cline-worktrees-cd456-other", ["superpowers:brainstorming"]);
			expect(await loadReferenceSkills({ workspaceId: other, home, repoName: "other", now })).toEqual([
				"superpowers:test-driven-development",
				"superpowers:systematic-debugging",
			]);
		});
	});

	it("seeds test-driven-development and systematic-debugging when nothing was scanned or persisted", async () => {
		await withTemporaryHome(async (home) => {
			const skills = await loadReferenceSkills({
				workspaceId: workspace("seed"),
				home,
				repoName: "my-kanban",
				now: Date.now(),
			});
			expect(skills).toEqual(["superpowers:test-driven-development", "superpowers:systematic-debugging"]);
		});
	});

	it("caches the result for one hour", async () => {
		await withTemporaryHome(async (home) => {
			const workspaceId = workspace("cache");
			const now = Date.now();
			writeTranscript(home, "-Users-x--cline-worktrees-ab123-my-kanban", ["a:one"]);
			expect(await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now })).toEqual(["a:one"]);
			writeTranscript(home, "-Users-x--cline-worktrees-cd456-my-kanban", ["b:two"]);
			expect(await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now: now + 60_000 })).toEqual([
				"a:one",
			]);
			expect(
				await loadReferenceSkills({ workspaceId, home, repoName: "my-kanban", now: now + 2 * HOUR_MS }),
			).toEqual(["a:one", "b:two"]);
		});
	});
});

describe("resolveSkillSources", () => {
	it("picks the highest plugin version", async () => {
		await withTemporaryHome(async (home) => {
			installPluginSkill(home, "superpowers", "6.4.1", "test-driven-development");
			const latest = installPluginSkill(home, "superpowers", "7.0.0", "test-driven-development");
			const sources = await resolveSkillSources(home, ["superpowers:test-driven-development"]);
			expect(sources).toEqual([{ name: "test-driven-development", dir: latest }]);
		});
	});

	it("resolves bare names under ~/.claude/skills", async () => {
		await withTemporaryHome(async (home) => {
			const dir = join(home, ".claude", "skills", "graphify");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "SKILL.md"), "x");
			expect(await resolveSkillSources(home, ["graphify"])).toEqual([{ name: "graphify", dir }]);
		});
	});

	it("warns and skips a skill that is not installed, keeping the rest", async () => {
		await withTemporaryHome(async (home) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const dir = installPluginSkill(home, "superpowers", "7.0.0", "systematic-debugging");
			const sources = await resolveSkillSources(home, ["superpowers:missing", "superpowers:systematic-debugging"]);
			expect(sources).toEqual([{ name: "systematic-debugging", dir }]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0])).toContain("superpowers:missing");
		});
	});
});

describe("listInstalledSkillNames", () => {
	it("lists latest plugin skills as plugin:name and bare skills", async () => {
		await withTemporaryHome(async (home) => {
			installPluginSkill(home, "superpowers", "6.4.1", "old-only");
			installPluginSkill(home, "superpowers", "7.0.0", "brainstorming");
			const bare = join(home, ".claude", "skills", "graphify");
			mkdirSync(bare, { recursive: true });
			writeFileSync(join(bare, "SKILL.md"), "x");
			expect((await listInstalledSkillNames(home)).sort()).toEqual(["graphify", "superpowers:brainstorming"]);
		});
	});
});
