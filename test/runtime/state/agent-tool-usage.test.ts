import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadAgentMcpUsage, loadAgentSkillUsage } from "../../../src/state/agent-tool-usage";
import { createTempDir } from "../../utilities/temp-dir";

const DAY_MS = 24 * 60 * 60 * 1000;

async function withTemporaryHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const { path: home, cleanup } = createTempDir("kanban-tool-usage-");
	try {
		return await run(home);
	} finally {
		cleanup();
	}
}

function rolloutCall(call: { name: string; namespace?: string; arguments?: string }): string {
	return JSON.stringify({ type: "response_item", payload: { type: "function_call", ...call } });
}

function writeRollout(home: string, lines: string[], ageMs = 0): string {
	const file = join(home, ".codex", "sessions", "2026", "11", "06", `rollout-${lines.length}-${ageMs}.jsonl`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${lines.join("\n")}\n`);
	const when = new Date(Date.now() - ageMs);
	utimesSync(file, when, when);
	return file;
}

function writeOpencodeConfig(home: string, servers: string[]): void {
	const file = join(home, ".config", "opencode", "opencode.jsonc");
	mkdirSync(dirname(file), { recursive: true });
	const mcp = Object.fromEntries(
		servers.map((name) => [name, { type: "remote", url: `https://example.com/${name}` }]),
	);
	writeFileSync(file, `// comment\n{ "mcp": ${JSON.stringify(mcp)}, /* trailing */ }\n`);
}

interface OpencodeToolFixture {
	tool: string;
	name?: string;
	timeCreated: number;
}

/** Legacy `part` rows (OpenCode before 2026-10-28) and/or current `session_message` assistant rows. */
function writeOpencodeDb(
	home: string,
	fixture: { legacy?: OpencodeToolFixture[]; current?: OpencodeToolFixture[] },
): void {
	const file = join(home, ".local", "share", "opencode", "opencode.db");
	mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	if (fixture.legacy) {
		db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL, data TEXT NOT NULL)");
		const insert = db.prepare("INSERT INTO part (id, time_created, data) VALUES (?, ?, ?)");
		fixture.legacy.forEach((entry, index) => {
			const input = entry.name ? { name: entry.name } : {};
			insert.run(
				`p${index}`,
				entry.timeCreated,
				JSON.stringify({ type: "tool", tool: entry.tool, state: { input } }),
			);
		});
	}
	if (fixture.current) {
		db.exec(
			"CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
		);
		const insert = db.prepare(
			"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, 's', ?, ?, ?, ?, ?)",
		);
		fixture.current.forEach((entry, index) => {
			const input = entry.name ? { id: entry.name } : {};
			const data = {
				content: [
					{ type: "text", text: "hi" },
					{ type: "tool", name: entry.tool, state: { input } },
				],
			};
			insert.run(`m${index}`, "assistant", index, entry.timeCreated, entry.timeCreated, JSON.stringify(data));
		});
		// A user row and a non-tool assistant row must not count.
		insert.run(
			"mu",
			"user",
			98,
			fixture.current[0]?.timeCreated ?? 0,
			0,
			JSON.stringify({ content: [{ type: "tool", name: "playwright_x" }] }),
		);
	}
	db.close();
}

describe("loadAgentMcpUsage codex", () => {
	it("counts calls per mcp server from rollouts, flat and namespaced, ignoring old files", async () => {
		await withTemporaryHome(async (home) => {
			writeRollout(home, [
				rolloutCall({ name: "mcp__playwright__browser_click" }),
				rolloutCall({ name: "mcp__playwright__browser_navigate" }),
				rolloutCall({ name: "js", namespace: "mcp__cua_repl" }),
				rolloutCall({ name: "shell" }),
			]);
			writeRollout(home, [rolloutCall({ name: "mcp__stale__tool" })], 40 * DAY_MS);
			const usage = await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: Date.now() - 30 * DAY_MS });
			expect(Object.fromEntries(usage ?? [])).toEqual({ playwright: 2, cua_repl: 1 });
		});
	});

	it("returns an empty map when there are no rollouts", async () => {
		await withTemporaryHome(async (home) => {
			expect(await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: 0 })).toEqual(new Map());
		});
	});
});

describe("loadAgentSkillUsage codex", () => {
	it("counts skills whose SKILL.md a command read", async () => {
		await withTemporaryHome(async (home) => {
			writeRollout(home, [
				rolloutCall({
					name: "shell",
					arguments: JSON.stringify({ command: ["cat", "/x/skills/graphify/SKILL.md"] }),
				}),
				rolloutCall({ name: "shell", arguments: JSON.stringify({ command: ["ls"] }) }),
			]);
			const usage = await loadAgentSkillUsage({ agentId: "codex", home, sinceMs: 0 });
			expect(Object.fromEntries(usage ?? [])).toEqual({ graphify: 1 });
		});
	});
});

describe("opencode usage", () => {
	const now = Date.now();
	const sinceMs = now - 30 * DAY_MS;

	it("reads session_message and the legacy part table together (longest server prefix wins)", async () => {
		await withTemporaryHome(async (home) => {
			writeOpencodeConfig(home, ["playwright", "gh_grep", "gh"]);
			writeOpencodeDb(home, {
				legacy: [
					{ tool: "playwright_browser_click", timeCreated: now },
					{ tool: "skill", name: "graphify", timeCreated: now },
					{ tool: "playwright_browser_click", timeCreated: now - 40 * DAY_MS },
				],
				current: [
					{ tool: "playwright_browser_click", timeCreated: now },
					{ tool: "gh_grep_searchGitHub", timeCreated: now },
					{ tool: "shell", timeCreated: now },
					{ tool: "skill", name: "graphify", timeCreated: now },
					{ tool: "skill", name: "tdd", timeCreated: now },
					{ tool: "playwright_browser_click", timeCreated: now - 40 * DAY_MS },
				],
			});
			expect(Object.fromEntries((await loadAgentMcpUsage({ agentId: "opencode", home, sinceMs })) ?? [])).toEqual({
				playwright: 2,
				gh_grep: 1,
			});
			expect(Object.fromEntries((await loadAgentSkillUsage({ agentId: "opencode", home, sinceMs })) ?? [])).toEqual({
				graphify: 2,
				tdd: 1,
			});
		});
	});

	it("works with only session_message (new db) or only part (old db)", async () => {
		await withTemporaryHome(async (home) => {
			writeOpencodeConfig(home, ["playwright"]);
			writeOpencodeDb(home, { current: [{ tool: "playwright_browser_click", timeCreated: now }] });
			expect(Object.fromEntries((await loadAgentMcpUsage({ agentId: "opencode", home, sinceMs })) ?? [])).toEqual({
				playwright: 1,
			});
		});
		await withTemporaryHome(async (home) => {
			writeOpencodeConfig(home, ["playwright"]);
			writeOpencodeDb(home, { legacy: [{ tool: "playwright_browser_click", timeCreated: now }] });
			expect(Object.fromEntries((await loadAgentMcpUsage({ agentId: "opencode", home, sinceMs })) ?? [])).toEqual({
				playwright: 1,
			});
		});
	});

	it("returns null when opencode.db is missing", async () => {
		await withTemporaryHome(async (home) => {
			writeOpencodeConfig(home, ["playwright"]);
			expect(await loadAgentMcpUsage({ agentId: "opencode", home, sinceMs: 0 })).toBeNull();
		});
	});

	it("returns null when opencode.db is unreadable", async () => {
		await withTemporaryHome(async (home) => {
			writeOpencodeConfig(home, ["playwright"]);
			const file = join(home, ".local", "share", "opencode", "opencode.db");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "this is not a sqlite database");
			expect(await loadAgentMcpUsage({ agentId: "opencode", home, sinceMs: 0 })).toBeNull();
			expect(await loadAgentSkillUsage({ agentId: "opencode", home, sinceMs: 0 })).toBeNull();
		});
	});
});

describe("usage cache", () => {
	it("does not re-read rollouts within the hour", async () => {
		await withTemporaryHome(async (home) => {
			const file = writeRollout(home, [rolloutCall({ name: "mcp__playwright__browser_click" })]);
			const first = await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: 0 });
			expect(Object.fromEntries(first ?? [])).toEqual({ playwright: 1 });
			rmSync(file);
			// Source is gone; a re-read would return an empty map.
			const second = await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: 0 });
			expect(Object.fromEntries(second ?? [])).toEqual({ playwright: 1 });
		});
	});

	it("re-reads after the hour", async () => {
		await withTemporaryHome(async (home) => {
			const file = writeRollout(home, [rolloutCall({ name: "mcp__playwright__browser_click" })]);
			await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: 0 });
			rmSync(file);
			vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61 * 60 * 1000 });
			try {
				expect(await loadAgentMcpUsage({ agentId: "codex", home, sinceMs: 0 })).toEqual(new Map());
			} finally {
				vi.useRealTimers();
			}
		});
	});
});

describe("antigravity usage", () => {
	it("is unknown", async () => {
		expect(await loadAgentMcpUsage({ agentId: "antigravity", home: "/nonexistent", sinceMs: 0 })).toBeNull();
	});
});
