import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { EffectiveSkillSet } from "../../../src/core/employee-skill-set";
import {
	buildCodexLeanOverrides,
	buildOpencodeLeanConfig,
	type CodexLeanInventory,
	deliverTaskSkills,
	MANAGED_SKILL_MARKER,
	parseCodexSkillCatalog,
} from "../../../src/terminal/task-skill-delivery";
import { createGitTestEnv } from "../../utilities/git-env";

let root: string;

function makeSkill(name: string): { name: string; dir: string } {
	const dir = join(root, "sources", name);
	mkdirSync(join(dir, "references"), { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
	writeFileSync(join(dir, "references", "notes.md"), "notes");
	return { name, dir };
}

function createWorktree(): { cwd: string; excludePath: string } {
	const cwd = join(root, "worktree");
	mkdirSync(cwd, { recursive: true });
	const env = createGitTestEnv();
	execFileSync("git", ["init", "-q"], { cwd, env });
	const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
		cwd,
		env,
		encoding: "utf8",
	}).trim();
	return { cwd, excludePath: resolve(cwd, excludePath) };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kanban-skill-delivery-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("deliverTaskSkills", () => {
	it("copies each skill folder into .agents/skills with a managed marker", async () => {
		const { cwd } = createWorktree();
		const tdd = makeSkill("test-driven-development");
		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd] });
		const target = join(cwd, ".agents", "skills", "test-driven-development");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("name: test-driven-development");
		expect(readFileSync(join(target, "references", "notes.md"), "utf8")).toBe("notes");
		expect(existsSync(join(target, MANAGED_SKILL_MARKER))).toBe(true);
	});

	it("removes a managed skill dropped from the set and keeps an unmarked repo skill", async () => {
		const { cwd } = createWorktree();
		const tdd = makeSkill("test-driven-development");
		const debugging = makeSkill("systematic-debugging");
		const repoSkill = join(cwd, ".agents", "skills", "repo-owned");
		mkdirSync(repoSkill, { recursive: true });
		writeFileSync(join(repoSkill, "SKILL.md"), "repo");

		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd, debugging] });
		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd] });

		const skillsDir = join(cwd, ".agents", "skills");
		expect(existsSync(join(skillsDir, "test-driven-development", "SKILL.md"))).toBe(true);
		expect(existsSync(join(skillsDir, "systematic-debugging"))).toBe(false);
		expect(readFileSync(join(repoSkill, "SKILL.md"), "utf8")).toBe("repo");
	});

	it("never overwrites an unmarked repo folder with the same name", async () => {
		const { cwd } = createWorktree();
		const tdd = makeSkill("test-driven-development");
		const repoSkill = join(cwd, ".agents", "skills", "test-driven-development");
		mkdirSync(repoSkill, { recursive: true });
		writeFileSync(join(repoSkill, "SKILL.md"), "repo version");
		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd] });
		expect(readFileSync(join(repoSkill, "SKILL.md"), "utf8")).toBe("repo version");
		expect(existsSync(join(repoSkill, MANAGED_SKILL_MARKER))).toBe(false);
	});

	it("hands off codex -> opencode: moves the set to .opencode/skills and leaves no managed codex copy", async () => {
		const { cwd } = createWorktree();
		const tdd = makeSkill("test-driven-development");
		const debugging = makeSkill("systematic-debugging");
		const repoSkill = join(cwd, ".agents", "skills", "repo-owned");
		mkdirSync(repoSkill, { recursive: true });
		writeFileSync(join(repoSkill, "SKILL.md"), "repo");

		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd, debugging] });
		await deliverTaskSkills({ cwd, agentId: "opencode", skills: [debugging] });

		expect(existsSync(join(cwd, ".agents", "skills", "test-driven-development"))).toBe(false);
		expect(existsSync(join(cwd, ".agents", "skills", "systematic-debugging"))).toBe(false);
		expect(existsSync(join(cwd, ".opencode", "skills", "systematic-debugging", "SKILL.md"))).toBe(true);
		expect(existsSync(join(cwd, ".opencode", "skills", "test-driven-development"))).toBe(false);
		expect(readFileSync(join(repoSkill, "SKILL.md"), "utf8")).toBe("repo");
	});

	it("adds both skill dirs to info/exclude exactly once across launches", async () => {
		const { cwd, excludePath } = createWorktree();
		writeFileSync(excludePath, "# existing\n.agents/");
		const tdd = makeSkill("test-driven-development");
		await deliverTaskSkills({ cwd, agentId: "codex", skills: [tdd] });
		await deliverTaskSkills({ cwd, agentId: "opencode", skills: [tdd] });
		const lines = readFileSync(excludePath, "utf8").split("\n");
		expect(lines.filter((line) => line === ".agents/skills/")).toHaveLength(1);
		expect(lines.filter((line) => line === ".opencode/skills/")).toHaveLength(1);
		expect(lines.slice(0, 2)).toEqual(["# existing", ".agents/"]);
	});
});

describe("buildCodexLeanOverrides", () => {
	const inventory: CodexLeanInventory = {
		enabledPlugins: ["ponytail@ponytail", "unified-computer-use@openai-bundled", "superpowers@openai-curated-remote"],
		pluginMcpServers: new Map([["unified-computer-use@openai-bundled", ["cua_repl"]]]),
		catalog: ["imagegen", "ponytail:ponytail", "graphify", "test-driven-development"],
		configMcpServers: ["node_repl", "context7"],
	};
	const skills = [{ name: "test-driven-development", dir: "/skills/test-driven-development" }];

	function overrides(set: EffectiveSkillSet): string[] {
		const args = buildCodexLeanOverrides(inventory, set);
		const values: string[] = [];
		for (let index = 0; index < args.length; index += 2) {
			expect(args[index]).toBe("-c");
			values.push(args[index + 1] ?? "");
		}
		return values;
	}

	it("turns plugins off with bare keys and keeps a plugin that provides a used MCP server", () => {
		const values = overrides({ skills, mcpEnabled: ["cua_repl"] });
		expect(values).toContain("plugins.ponytail@ponytail.enabled=false");
		expect(values).toContain("plugins.superpowers@openai-curated-remote.enabled=false");
		expect(values.some((value) => value.includes("unified-computer-use"))).toBe(false);
		expect(values.some((value) => value.startsWith('plugins."'))).toBe(false);
	});

	it("denies every catalog skill outside the set and the bundled skills", () => {
		const values = overrides({ skills, mcpEnabled: [] });
		expect(values).toContain("skills.bundled.enabled=false");
		expect(values).toContain(
			'skills.config=[{name="imagegen",enabled=false},{name="ponytail:ponytail",enabled=false},{name="graphify",enabled=false}]',
		);
	});

	it("turns off config-declared MCP servers that were not used", () => {
		const values = overrides({ skills, mcpEnabled: ["context7"] });
		expect(values).toContain("mcp_servers.node_repl.enabled=false");
		expect(values).not.toContain("mcp_servers.context7.enabled=false");
		// Plugin servers follow their plugin; an override on them would make codex fail to start.
		expect(values.some((value) => value.startsWith("mcp_servers.cua_repl"))).toBe(false);
	});

	it("leaves every MCP server and every MCP plugin on when usage is unknown", () => {
		const values = overrides({ skills, mcpEnabled: null });
		expect(values.some((value) => value.startsWith("mcp_servers."))).toBe(false);
		expect(values.some((value) => value.includes("unified-computer-use"))).toBe(false);
		expect(values).toContain("plugins.ponytail@ponytail.enabled=false");
	});
});

describe("parseCodexSkillCatalog", () => {
	it("reads skill names from the escaped prompt-input JSON", () => {
		const text =
			"<skills_instructions>\n### Available skills\n" +
			"- imagegen: Generate images (file: r2/imagegen/SKILL.md)\n" +
			"- ponytail:ponytail: Lazy senior dev mode: smallest change (file: r9/ponytail/SKILL.md)\n" +
			"</skills_instructions>";
		const stdout = JSON.stringify([{ type: "message", content: [{ type: "input_text", text }] }]);
		expect(parseCodexSkillCatalog(stdout)).toEqual(["imagegen", "ponytail:ponytail"]);
	});

	it("returns nothing for unreadable output", () => {
		expect(parseCodexSkillCatalog(null)).toEqual([]);
		expect(parseCodexSkillCatalog("not json")).toEqual([]);
	});
});

describe("buildOpencodeLeanConfig", () => {
	it("allows only the set and copies full definitions of unused MCP servers with enabled false", async () => {
		mkdirSync(join(root, ".config", "opencode"), { recursive: true });
		writeFileSync(
			join(root, ".config", "opencode", "opencode.jsonc"),
			`{
  // comment
  "mcp": {
    "playwright": { "type": "local", "command": ["npx", "@playwright/mcp@latest"], "enabled": true },
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" },
  },
}`,
		);
		const config = await buildOpencodeLeanConfig(
			{ skills: [{ name: "test-driven-development", dir: "/x" }], mcpEnabled: ["context7"] },
			root,
		);
		expect(config.permission.skill).toEqual({ "*": "deny", "test-driven-development": "allow" });
		expect(config.mcp).toEqual({
			playwright: { type: "local", command: ["npx", "@playwright/mcp@latest"], enabled: false },
		});
	});

	it("leaves MCP alone when usage is unknown", async () => {
		const config = await buildOpencodeLeanConfig({ skills: [], mcpEnabled: null }, root);
		expect(config).toEqual({ permission: { skill: { "*": "deny" } } });
	});
});
