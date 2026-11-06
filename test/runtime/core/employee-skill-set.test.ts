import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveEffectiveSkillSet } from "../../../src/core/employee-skill-set";
import type { DeclaredEmployee } from "../../../src/state/employees";
import { createTempDir } from "../../utilities/temp-dir";

function declared(patch: Partial<DeclaredEmployee>): DeclaredEmployee {
	return { status: "active", strong: [], avoid: [], notes: "", skills: [], mcp: [], ...patch };
}

function installBare(home: string, name: string): void {
	const dir = join(home, ".claude", "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "x");
}

function installPlugin(home: string, plugin: string, skill: string): void {
	const dir = join(home, ".claude", "plugins", "cache", "market", plugin, "1.0.0", "skills", skill);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "x");
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const { path, cleanup } = createTempDir("kanban-skill-set-");
	try {
		return await run(path);
	} finally {
		cleanup();
	}
}

const base = { reference: ["ref"], mcpUsage: null, model: null as string | null };

describe("resolveEffectiveSkillSet", () => {
	it("applies extras on the plain agent key to model-specific keys of that agent", async () => {
		await withHome(async (home) => {
			for (const name of ["ref", "extra"]) installBare(home, name);
			const result = await resolveEffectiveSkillSet({
				...base,
				agentId: "codex",
				model: "gpt-6-luna",
				declared: { codex: declared({ skills: ["extra"] }) },
				home,
			});
			expect(result.skills.map((skill) => skill.name)).toEqual(["ref", "extra"]);
		});
	});

	it("applies model-key extras only to that model", async () => {
		await withHome(async (home) => {
			for (const name of ["ref", "luna-only"]) installBare(home, name);
			const declaredMap = { "codex:gpt-6-luna": declared({ skills: ["luna-only"] }) };
			const luna = await resolveEffectiveSkillSet({
				...base,
				agentId: "codex",
				model: "gpt-6-luna",
				declared: declaredMap,
				home,
			});
			const sol = await resolveEffectiveSkillSet({
				...base,
				agentId: "codex",
				model: "gpt-6.1-sol",
				declared: declaredMap,
				home,
			});
			expect(luna.skills.map((skill) => skill.name)).toEqual(["ref", "luna-only"]);
			expect(sol.skills.map((skill) => skill.name)).toEqual(["ref"]);
		});
	});

	it("globs a trailing * against installed skill names", async () => {
		await withHome(async (home) => {
			installBare(home, "ref");
			installPlugin(home, "superpowers", "brainstorming");
			installPlugin(home, "superpowers", "writing-plans");
			installPlugin(home, "other", "thing");
			const result = await resolveEffectiveSkillSet({
				...base,
				agentId: "opencode",
				declared: { opencode: declared({ skills: ["superpowers:*"] }) },
				home,
			});
			expect(result.skills.map((skill) => skill.name).sort()).toEqual(["brainstorming", "ref", "writing-plans"]);
		});
	});

	it("skips a reference skill that is not installed and keeps going", async () => {
		await withHome(async (home) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			installBare(home, "present");
			const result = await resolveEffectiveSkillSet({
				...base,
				reference: ["missing", "present"],
				agentId: "codex",
				declared: {},
				home,
			});
			expect(result.skills.map((skill) => skill.name)).toEqual(["present"]);
			expect(warn).toHaveBeenCalledTimes(1);
			warn.mockRestore();
		});
	});

	it("uses used servers plus declared extras, or null when usage is unknown", async () => {
		await withHome(async (home) => {
			const declaredMap = {
				codex: declared({ mcp: ["context7"] }),
				"codex:gpt-6-luna": declared({ mcp: ["gh_grep"] }),
			};
			const known = await resolveEffectiveSkillSet({
				...base,
				reference: [],
				agentId: "codex",
				model: "gpt-6-luna",
				declared: declaredMap,
				mcpUsage: new Map([
					["playwright", 3],
					["idle", 0],
				]),
				home,
			});
			expect(known.mcpEnabled).toEqual(["playwright", "context7", "gh_grep"]);
			const unknown = await resolveEffectiveSkillSet({
				...base,
				reference: [],
				agentId: "codex",
				declared: declaredMap,
				home,
			});
			expect(unknown.mcpEnabled).toBeNull();
		});
	});
});
