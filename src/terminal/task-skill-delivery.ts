// Lean task sessions: copies the employee's skill set into the task worktree and builds the per-agent switches
// that turn global skills, plugins and unused MCP servers off for one session. Forms are the ones proven by the
// spike in contexte/employee-skill-sets.md; never writes ~/.codex, ~/.config/opencode, ~/.agents or ~/.gemini.
import { execFile } from "node:child_process";
import { cp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { EffectiveSkillSet } from "../core/employee-skill-set";
import { lockedFileSystem } from "../fs/locked-file-system";
import { parseJsonc } from "../state/agent-tool-usage";
import type { SkillSource } from "../state/reference-skills";
import { getGitStdout } from "../workspace/git-utils";

const execFileAsync = promisify(execFile);

export type LeanAgentId = "codex" | "opencode" | "antigravity";

export const MANAGED_SKILL_MARKER = ".kanban-managed";
const SKILL_DIRS: Record<LeanAgentId, string> = {
	codex: ".agents/skills",
	antigravity: ".agents/skills",
	opencode: ".opencode/skills",
};
const SKILL_EXCLUDE_LINES = [".agents/skills/", ".opencode/skills/"];
const CLI_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
	return await stat(path).then(
		() => true,
		() => false,
	);
}

/** Adds each missing line to the worktree's `info/exclude`, under a lock shared by every task of the repo. */
export async function appendGitExcludeLines(cwd: string, lines: string[]): Promise<void> {
	const excludePath = await getGitStdout(["rev-parse", "--git-path", "info/exclude"], cwd);
	const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : resolve(cwd, excludePath);
	await lockedFileSystem.withLock({ path: absoluteExcludePath }, async () => {
		const contents = await readFile(absoluteExcludePath, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") {
				return "";
			}
			throw error;
		});
		const present = new Set(contents.split(/\r?\n/u));
		const missing = lines.filter((line) => !present.has(line));
		if (missing.length === 0) {
			return;
		}
		const separator = contents && !contents.endsWith("\n") ? "\n" : "";
		await lockedFileSystem.writeTextFileAtomic(
			absoluteExcludePath,
			`${contents}${separator}${missing.join("\n")}\n`,
			{
				lock: null,
			},
		);
	});
}

/**
 * Copies each skill folder into the agent's project skill dir with a `.kanban-managed` marker, removes managed
 * folders that are not in the set (from both skill dirs, so a handoff to another agent leaves no stale copy), and
 * keeps both skill dirs out of git. Folders without the marker belong to the repo and are never touched.
 */
export async function deliverTaskSkills(input: {
	cwd: string;
	agentId: LeanAgentId;
	skills: SkillSource[];
}): Promise<void> {
	const targetDir = SKILL_DIRS[input.agentId];
	const keep = new Set(input.skills.map((skill) => skill.name));
	for (const dir of new Set(Object.values(SKILL_DIRS))) {
		const root = join(input.cwd, dir);
		for (const name of await readdir(root).catch(() => [])) {
			if (dir === targetDir && keep.has(name)) continue;
			if (await exists(join(root, name, MANAGED_SKILL_MARKER))) {
				await rm(join(root, name), { recursive: true, force: true });
			}
		}
	}
	for (const skill of input.skills) {
		const destination = join(input.cwd, targetDir, skill.name);
		if ((await exists(destination)) && !(await exists(join(destination, MANAGED_SKILL_MARKER)))) {
			continue;
		}
		// Re-copied every launch so an updated plugin version reaches the next session.
		await rm(destination, { recursive: true, force: true });
		await cp(skill.dir, destination, { recursive: true });
		await writeFile(join(destination, MANAGED_SKILL_MARKER), "");
	}
	await appendGitExcludeLines(input.cwd, SKILL_EXCLUDE_LINES);
}

// ---- Codex ----

export interface CodexLeanInventory {
	/** Plugin ids `codex plugin list` reports installed and enabled (remote plugins included). */
	enabledPlugins: string[];
	/** Plugin id -> MCP server names it provides (root `.mcp.json` of its cached versions). */
	pluginMcpServers: Map<string, string[]>;
	/** Every skill name in the session catalog (`codex debug prompt-input`), `~/.agents/skills` included. */
	catalog: string[];
	/** MCP servers declared in `~/.codex/config.toml` (an override on any other name makes codex fail to start). */
	configMcpServers: string[];
}

async function runCodex(binary: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync(binary, args, {
			timeout: CLI_TIMEOUT_MS,
			maxBuffer: 64 * 1024 * 1024,
		});
		return stdout;
	} catch (error) {
		// Fail open: the session still launches, only without the matching overrides.
		console.warn.bind(console)(`[kanban] lean codex session: \`codex ${args.join(" ")}\` failed.`, error);
		return null;
	}
}

function parseJson(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function parseEnabledPlugins(stdout: string | null): string[] {
	const parsed = parseJson(stdout);
	if (!isRecord(parsed) || !Array.isArray(parsed.installed)) return [];
	return parsed.installed
		.filter((plugin) => isRecord(plugin) && plugin.installed === true && plugin.enabled === true)
		.map((plugin) => (isRecord(plugin) ? plugin.pluginId : null))
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

// `[mcp_servers.node_repl]` or `[mcp_servers."node_repl"]`; sub-tables such as `[mcp_servers.node_repl.env]` do not match.
const CONFIG_MCP_SERVER_HEADER = /^\s*\[mcp_servers\.(?:"([A-Za-z0-9_-]+)"|([A-Za-z0-9_-]+))\]\s*$/gmu;

async function readCodexConfigMcpServers(home: string): Promise<string[]> {
	const raw = await readFile(join(home, ".codex", "config.toml"), "utf8").catch(() => "");
	return [...new Set([...raw.matchAll(CONFIG_MCP_SERVER_HEADER)].map((match) => match[1] ?? match[2] ?? ""))].filter(
		(name) => name.length > 0,
	);
}

const CATALOG_LINE = /^- (\S+?): .*\(file: [^)]*\)$/gmu;

function collectCatalogNames(value: unknown, names: Set<string>): void {
	if (typeof value === "string") {
		for (const match of value.matchAll(CATALOG_LINE)) {
			if (match[1]) names.add(match[1]);
		}
	} else if (Array.isArray(value)) {
		for (const item of value) collectCatalogNames(item, names);
	} else if (isRecord(value)) {
		for (const item of Object.values(value)) collectCatalogNames(item, names);
	}
}

/** Skill names from the `### Available skills` list of `codex debug prompt-input` (JSON with escaped text). */
export function parseCodexSkillCatalog(stdout: string | null): string[] {
	const names = new Set<string>();
	collectCatalogNames(parseJson(stdout), names);
	return [...names];
}

async function readPluginMcpServers(home: string, pluginId: string): Promise<string[]> {
	const at = pluginId.lastIndexOf("@");
	if (at <= 0) return [];
	const pluginDir = join(home, ".codex", "plugins", "cache", pluginId.slice(at + 1), pluginId.slice(0, at));
	const servers = new Set<string>();
	for (const version of await readdir(pluginDir).catch(() => [])) {
		const parsed = parseJson(await readFile(join(pluginDir, version, ".mcp.json"), "utf8").catch(() => null));
		if (!isRecord(parsed)) continue;
		// Two forms: `{ "mcpServers": { name: def } }` and the flat `{ name: def }`.
		const definitions = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
		for (const [name, definition] of Object.entries(definitions)) {
			if (isRecord(definition)) servers.add(name);
		}
	}
	return [...servers];
}

async function loadCodexLeanInventoryUncached(binary: string, home: string): Promise<CodexLeanInventory> {
	const [pluginStdout, catalogStdout, configMcpServers] = await Promise.all([
		runCodex(binary, ["plugin", "list", "--json"]),
		runCodex(binary, ["debug", "prompt-input", "ok"]),
		readCodexConfigMcpServers(home),
	]);
	const enabledPlugins = parseEnabledPlugins(pluginStdout);
	const pluginMcpServers = new Map<string, string[]>();
	for (const pluginId of enabledPlugins) {
		const servers = await readPluginMcpServers(home, pluginId);
		if (servers.length > 0) pluginMcpServers.set(pluginId, servers);
	}
	return {
		enabledPlugins,
		pluginMcpServers,
		catalog: parseCodexSkillCatalog(catalogStdout),
		configMcpServers,
	};
}

// ponytail: cached for the runtime process; a plugin installed later needs a Kanban restart to be switched off.
const codexInventoryCache = new Map<string, Promise<CodexLeanInventory>>();

export function loadCodexLeanInventory(binary: string, home: string): Promise<CodexLeanInventory> {
	const key = `${binary}\u0000${home}`;
	let cached = codexInventoryCache.get(key);
	if (!cached) {
		cached = loadCodexLeanInventoryUncached(binary, home);
		codexInventoryCache.set(key, cached);
	}
	return cached;
}

/** `-c` overrides for one lean Codex session. Plugin keys are bare: the quoted form is silently ignored. */
export function buildCodexLeanOverrides(inventory: CodexLeanInventory, set: EffectiveSkillSet): string[] {
	const args: string[] = [];
	const keptServers = set.mcpEnabled === null ? null : new Set(set.mcpEnabled);
	for (const pluginId of inventory.enabledPlugins) {
		// Plugin MCP servers vanish with their plugin, so a plugin providing a used server stays on.
		const servers = inventory.pluginMcpServers.get(pluginId) ?? [];
		const providesKeptServer = servers.some((server) => keptServers === null || keptServers.has(server));
		if (!providesKeptServer) {
			args.push("-c", `plugins.${pluginId}.enabled=false`);
		}
	}
	args.push("-c", "skills.bundled.enabled=false");
	const kept = new Set(set.skills.map((skill) => skill.name));
	const denied = inventory.catalog.filter((name) => !kept.has(name));
	if (denied.length > 0) {
		const entries = denied.map((name) => `{name=${JSON.stringify(name)},enabled=false}`);
		args.push("-c", `skills.config=[${entries.join(",")}]`);
	}
	if (keptServers !== null) {
		for (const server of inventory.configMcpServers) {
			if (!keptServers.has(server)) {
				args.push("-c", `mcp_servers.${server}.enabled=false`);
			}
		}
	}
	return args;
}

// ---- OpenCode ----

async function readOpencodeMcpDefinitions(home: string): Promise<Record<string, unknown>> {
	const raw = await readFile(join(home, ".config", "opencode", "opencode.jsonc"), "utf8").catch(() => null);
	if (raw === null) return {};
	try {
		const config = parseJsonc(raw);
		return isRecord(config) && isRecord(config.mcp) ? config.mcp : {};
	} catch {
		return {};
	}
}

/**
 * The lean part of a per-task OpenCode config: skill permission deny-all plus the set, and each unused MCP server
 * with its FULL definition and `enabled: false` (an entry with only `enabled` is silently dropped by OpenCode).
 */
export async function buildOpencodeLeanConfig(
	set: EffectiveSkillSet,
	home: string,
): Promise<{ permission: { skill: Record<string, "allow" | "deny"> }; mcp?: Record<string, unknown> }> {
	const skill: Record<string, "allow" | "deny"> = { "*": "deny" };
	for (const source of set.skills) skill[source.name] = "allow";
	if (set.mcpEnabled === null) {
		return { permission: { skill } };
	}
	const kept = new Set(set.mcpEnabled);
	const mcp: Record<string, unknown> = {};
	for (const [name, definition] of Object.entries(await readOpencodeMcpDefinitions(home))) {
		if (!kept.has(name) && isRecord(definition)) {
			mcp[name] = { ...definition, enabled: false };
		}
	}
	return Object.keys(mcp).length > 0 ? { permission: { skill }, mcp } : { permission: { skill } };
}
