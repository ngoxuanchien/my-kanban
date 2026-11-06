import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ToolUsageAgentId = "codex" | "opencode" | "antigravity";

interface AgentUsageInput {
	agentId: ToolUsageAgentId;
	home: string;
	sinceMs: number;
}

type UsageMap = Map<string, number>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bump(map: UsageMap, key: string, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

// ---- Codex: rollout jsonl under ~/.codex/sessions ----

async function readCodexRollouts(home: string, sinceMs: number): Promise<string[]> {
	const root = join(home, ".codex", "sessions");
	const entries = await readdir(root, { recursive: true }).catch(() => null);
	if (entries === null) return [];
	const texts: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".jsonl")) continue;
		const path = join(root, entry);
		const info = await stat(path).catch(() => null);
		if (!info || info.mtimeMs < sinceMs) continue;
		texts.push(await readFile(path, "utf8").catch(() => ""));
	}
	return texts;
}

function codexFunctionCall(line: string): { name: string; namespace: string; arguments: string } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : parsed;
	if (!isRecord(payload) || payload.type !== "function_call" || typeof payload.name !== "string") return null;
	return {
		name: payload.name,
		namespace: typeof payload.namespace === "string" ? payload.namespace : "",
		arguments: typeof payload.arguments === "string" ? payload.arguments : "",
	};
}

/** `mcp__<server>` namespace with the tool as `name`, or the flat `mcp__<server>__<tool>` name. */
function codexMcpServer(call: { name: string; namespace: string }): string | null {
	for (const candidate of [call.namespace, call.name]) {
		if (!candidate.startsWith("mcp__")) continue;
		const server = candidate.slice("mcp__".length).split("__")[0];
		if (server) return server;
	}
	return null;
}

async function loadCodexMcpUsage(home: string, sinceMs: number): Promise<UsageMap> {
	const usage: UsageMap = new Map();
	for (const text of await readCodexRollouts(home, sinceMs)) {
		for (const line of text.split("\n")) {
			if (!line.includes("mcp__")) continue;
			const call = codexFunctionCall(line);
			const server = call ? codexMcpServer(call) : null;
			if (server) bump(usage, server);
		}
	}
	return usage;
}

// Codex has no skill tool: a skill counts when a command reads its SKILL.md.
const CODEX_SKILL_READ = /skills\/([^/\\"\s]+)\/SKILL\.md/g;

async function loadCodexSkillUsage(home: string, sinceMs: number): Promise<UsageMap> {
	const usage: UsageMap = new Map();
	for (const text of await readCodexRollouts(home, sinceMs)) {
		for (const line of text.split("\n")) {
			if (!line.includes("SKILL.md")) continue;
			const call = codexFunctionCall(line);
			if (!call) continue;
			for (const match of call.arguments.matchAll(CODEX_SKILL_READ)) {
				if (match[1]) bump(usage, match[1]);
			}
		}
	}
	return usage;
}

// ---- OpenCode: ~/.local/share/opencode/opencode.db ----

/** Runs a read-only query. Returns null when the db is missing, unreadable, or no sqlite is available. */
async function queryOpencodeDb(dbPath: string, sql: string): Promise<Record<string, unknown>[] | null> {
	const present = await stat(dbPath).then(
		() => true,
		() => false,
	);
	if (!present) return null;
	const sqlite = process.getBuiltinModule("node:sqlite");
	if (sqlite) {
		try {
			const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				return db.prepare(sql).all();
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
	}
	try {
		const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		});
		const parsed: unknown = stdout.trim().length === 0 ? [] : JSON.parse(stdout);
		return Array.isArray(parsed) ? parsed.filter(isRecord) : null;
	} catch {
		return null;
	}
}

// OpenCode 2.2.5 stopped writing the legacy `part` table on 2026-10-28; current tool calls live in
// `session_message` (assistant rows, `content[]` items of type "tool"; a skill call names the skill in
// `state.input.id`, the legacy rows in `state.input.name`). Both are read so old data still counts.
const OPENCODE_LEGACY_SQL = (since: number) =>
	`SELECT json_extract(data, '$.tool') AS tool, json_extract(data, '$.state.input.name') AS name, COUNT(*) AS n
	 FROM part
	 WHERE json_extract(data, '$.type') = 'tool' AND time_created >= ${since}
	 GROUP BY tool, name`;
const OPENCODE_CURRENT_SQL = (since: number) =>
	`SELECT json_extract(c.value, '$.name') AS tool, COALESCE(json_extract(c.value, '$.state.input.name'), json_extract(c.value, '$.state.input.id')) AS name, COUNT(*) AS n
	 FROM session_message m, json_each(json_extract(m.data, '$.content')) c
	 WHERE m.type = 'assistant' AND json_extract(c.value, '$.type') = 'tool' AND m.time_created >= ${since}
	 GROUP BY tool, name`;

interface OpencodeToolCount {
	tool: string;
	name: string | null;
	n: number;
}

/** Tool call counts from both tables. Null when the db is unreadable or has neither table. */
async function queryOpencodeToolCounts(home: string, sinceMs: number): Promise<OpencodeToolCount[] | null> {
	const dbPath = join(home, ".local", "share", "opencode", "opencode.db");
	const since = Math.max(0, Math.floor(sinceMs));
	const tables = await queryOpencodeDb(
		dbPath,
		"SELECT name FROM sqlite_master WHERE name IN ('part', 'session_message')",
	);
	if (tables === null) return null;
	const present = new Set(tables.map((row) => row.name));
	const counts = new Map<string, OpencodeToolCount>();
	const sources = [
		{ table: "part", sql: OPENCODE_LEGACY_SQL(since) },
		{ table: "session_message", sql: OPENCODE_CURRENT_SQL(since) },
	].filter((source) => present.has(source.table));
	if (sources.length === 0) return null;
	for (const source of sources) {
		const rows = await queryOpencodeDb(dbPath, source.sql);
		if (rows === null) return null;
		for (const row of rows) {
			if (typeof row.tool !== "string") continue;
			const name = typeof row.name === "string" ? row.name : null;
			const key = `${row.tool}\u0000${name ?? ""}`;
			const entry = counts.get(key) ?? { tool: row.tool, name, n: 0 };
			entry.n += Number(row.n);
			counts.set(key, entry);
		}
	}
	return [...counts.values()];
}

/** Removes `//` and block comments (outside strings) and trailing commas so JSON.parse can read opencode.jsonc. */
function parseJsonc(text: string): unknown {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		const next = text[i + 1];
		if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 1;
			} else if (ch === '"') {
				inString = false;
			}
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			out += "\n";
		} else if (ch === "/" && next === "*") {
			const end = text.indexOf("*/", i + 2);
			if (end === -1) break;
			i = end + 1;
		} else {
			out += ch;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function readOpencodeMcpServerNames(home: string): Promise<string[] | null> {
	const raw = await readFile(join(home, ".config", "opencode", "opencode.jsonc"), "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const config = parseJsonc(raw);
		return isRecord(config) && isRecord(config.mcp) ? Object.keys(config.mcp) : [];
	} catch {
		return null;
	}
}

async function loadOpencodeMcpUsage(home: string, sinceMs: number): Promise<UsageMap | null> {
	const servers = await readOpencodeMcpServerNames(home);
	if (servers === null) return null;
	const rows = await queryOpencodeToolCounts(home, sinceMs);
	if (rows === null) return null;
	// Longest name first so `gh_grep` wins over a hypothetical `gh`.
	const byLength = [...servers].sort((a, b) => b.length - a.length);
	const usage: UsageMap = new Map();
	for (const row of rows) {
		const server = byLength.find((name) => row.tool.startsWith(`${name}_`));
		if (server) bump(usage, server, row.n);
	}
	return usage;
}

async function loadOpencodeSkillUsage(home: string, sinceMs: number): Promise<UsageMap | null> {
	const rows = await queryOpencodeToolCounts(home, sinceMs);
	if (rows === null) return null;
	const usage: UsageMap = new Map();
	for (const row of rows) {
		if (row.tool === "skill" && row.name !== null) bump(usage, row.name, row.n);
	}
	return usage;
}

// ---- Public API ----

const USAGE_CACHE_TTL_MS = 60 * 60 * 1000;
const usageCache = new Map<string, { usage: UsageMap | null; at: number }>();

/** Rollout scans cost ~1 s on a real machine, and launches call this every time: cache per agent and home. */
async function cachedUsage(
	kind: "mcp" | "skill",
	input: AgentUsageInput,
	load: () => Promise<UsageMap | null>,
): Promise<UsageMap | null> {
	const key = `${kind}\u0000${input.agentId}\u0000${input.home}`;
	const cached = usageCache.get(key);
	if (cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) return cached.usage;
	const usage = await load();
	usageCache.set(key, { usage, at: Date.now() });
	return usage;
}

/** Calls per MCP server name. `null` = unknown (callers fail open and leave every server on). */
export async function loadAgentMcpUsage(input: AgentUsageInput): Promise<UsageMap | null> {
	return await cachedUsage("mcp", input, async () => {
		if (input.agentId === "codex") return await loadCodexMcpUsage(input.home, input.sinceMs);
		if (input.agentId === "opencode") return await loadOpencodeMcpUsage(input.home, input.sinceMs);
		// Antigravity: no usage source found in the spike (contexte/employee-skill-sets.md).
		return null;
	});
}

/** Calls per skill name, used only by `employee show`. `null` = unknown. */
export async function loadAgentSkillUsage(input: AgentUsageInput): Promise<UsageMap | null> {
	return await cachedUsage("skill", input, async () => {
		if (input.agentId === "codex") return await loadCodexSkillUsage(input.home, input.sinceMs);
		if (input.agentId === "opencode") return await loadOpencodeSkillUsage(input.home, input.sinceMs);
		return null;
	});
}
