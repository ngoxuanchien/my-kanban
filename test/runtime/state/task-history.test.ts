import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	deleteTaskHistory,
	loadTaskHistory,
	recordTaskHistoryEvent,
	type TaskHistoryEvent,
} from "../../../src/state/task-history";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "task-history-test-workspace";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-task-history-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanup();
	}
}

describe("task history store", () => {
	it("records and loads task history events in a round-trip", async () => {
		await withTemporaryHome(async () => {
			const recorded = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "started", agentId: "codex" },
				() => 100,
			);
			expect(recorded).toBe(true);

			const history = await loadTaskHistory(WORKSPACE_ID, "task-1");
			expect(history).toEqual([
				{
					type: "started",
					agentId: "codex",
					at: 100,
				},
			]);

			const fileContent = JSON.parse(
				readFileSync(join(getWorkspaceDirectoryPath(WORKSPACE_ID), "task-history", "task-1.json"), "utf8"),
			) as { version: number; events: TaskHistoryEvent[] };
			expect(fileContent.version).toBe(1);
			expect(fileContent.events).toHaveLength(1);
		});
	});

	it("fills stored fail event when duplicate fail provides detail", async () => {
		await withTemporaryHome(async () => {
			const first = await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", {
				type: "fail",
				agentId: "codex",
				round: 1,
			});
			expect(first).toBe(true);

			const dupNoDetail = await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", {
				type: "fail",
				agentId: "codex",
				round: 1,
			});
			expect(dupNoDetail).toBe(false);

			const filled = await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", {
				type: "fail",
				agentId: "codex",
				round: 1,
				detail: "failing tests output",
			});
			expect(filled).toBe(true);

			const secondDetail = await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", {
				type: "fail",
				agentId: "codex",
				round: 1,
				detail: "new detail should not overwrite",
			});
			expect(secondDetail).toBe(false);

			const history = await loadTaskHistory(WORKSPACE_ID, "task-1");
			expect(history).toHaveLength(1);
			expect(history[0]?.detail).toBe("failing tests output");
		});
	});

	it("stores 25,000-char detail as 20,000 chars plus suffix", async () => {
		await withTemporaryHome(async () => {
			const longDetail = "x".repeat(25_000);
			const recorded = await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", {
				type: "fail",
				agentId: "codex",
				round: 1,
				detail: longDetail,
			});
			expect(recorded).toBe(true);

			const history = await loadTaskHistory(WORKSPACE_ID, "task-1");
			expect(history[0]?.detail).toHaveLength(20_000 + "… (truncated)".length);
			expect(history[0]?.detail).toBe(`${"x".repeat(20_000)}… (truncated)`);
		});
	});

	it("sorts task history by at", async () => {
		await withTemporaryHome(async () => {
			await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "pass", agentId: "codex", commit: "abc" },
				() => 300,
			);
			expect(
				await recordTaskHistoryEvent(
					WORKSPACE_ID,
					"task-1",
					{ type: "pass", agentId: "codex", commit: "different-commit" },
					() => 400,
				),
			).toBe(false);
			await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "fail", agentId: "codex", round: 1, detail: "err" },
				() => 200,
			);
			await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", { type: "started", agentId: "codex" }, () => 100);

			const history = await loadTaskHistory(WORKSPACE_ID, "task-1");
			expect(history.map((e) => ({ type: e.type, at: e.at }))).toEqual([
				{ type: "started", at: 100 },
				{ type: "fail", at: 200 },
				{ type: "pass", at: 300 },
			]);
		});
	});

	it("returns empty array for missing or corrupt history file", async () => {
		await withTemporaryHome(async () => {
			expect(await loadTaskHistory(WORKSPACE_ID, "missing-task")).toEqual([]);

			const historyDir = join(getWorkspaceDirectoryPath(WORKSPACE_ID), "task-history");
			mkdirSync(historyDir, { recursive: true });
			writeFileSync(join(historyDir, "corrupt.json"), "{ invalid json", "utf8");
			expect(await loadTaskHistory(WORKSPACE_ID, "corrupt")).toEqual([]);
		});
	});

	it("persists two concurrent writes to one task file", async () => {
		await withTemporaryHome(async () => {
			const [first, second] = await Promise.all([
				recordTaskHistoryEvent(WORKSPACE_ID, "task-1", { type: "started", agentId: "codex" }, () => 100),
				recordTaskHistoryEvent(
					WORKSPACE_ID,
					"task-1",
					{ type: "pass", agentId: "codex", commit: "abc" },
					() => 200,
				),
			]);
			expect(first).toBe(true);
			expect(second).toBe(true);

			const history = await loadTaskHistory(WORKSPACE_ID, "task-1");
			expect(history).toHaveLength(2);
			expect(history[0]?.type).toBe("started");
			expect(history[1]?.type).toBe("pass");
		});
	});

	it("delete removes the history file and leaves agent-scores.json untouched", async () => {
		await withTemporaryHome(async () => {
			const workspaceDir = getWorkspaceDirectoryPath(WORKSPACE_ID);
			mkdirSync(workspaceDir, { recursive: true });
			writeFileSync(join(workspaceDir, "agent-scores.json"), JSON.stringify({ version: 1, events: [] }), "utf8");

			await recordTaskHistoryEvent(WORKSPACE_ID, "task-1", { type: "started", agentId: "codex" });
			expect(await loadTaskHistory(WORKSPACE_ID, "task-1")).toHaveLength(1);

			await deleteTaskHistory(WORKSPACE_ID, "task-1");
			expect(await loadTaskHistory(WORKSPACE_ID, "task-1")).toEqual([]);

			const scoresRaw = readFileSync(join(workspaceDir, "agent-scores.json"), "utf8");
			expect(JSON.parse(scoresRaw)).toEqual({ version: 1, events: [] });
		});
	});

	it("de-duplicates history events within 5000ms and session events per session id", async () => {
		await withTemporaryHome(async () => {
			let now = 10_000;
			const r1 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "handoff", agentId: "codex", toAgentId: "opencode", round: 1, detail: "h" },
				() => now,
			);
			expect(r1).toBe(true);

			now = 12_000;
			const r2 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "handoff", agentId: "codex", toAgentId: "opencode", round: 1, detail: "h" },
				() => now,
			);
			expect(r2).toBe(false);

			now = 16_000;
			const r3 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "handoff", agentId: "codex", toAgentId: "opencode", round: 1, detail: "h" },
				() => now,
			);
			expect(r3).toBe(true);

			const s1 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "session", agentId: "codex", agentSession: { agentId: "codex", id: "sess-1" } },
				() => now,
			);
			expect(s1).toBe(true);

			now = 30_000;
			const s2 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "session", agentId: "codex", agentSession: { agentId: "codex", id: "sess-1" } },
				() => now,
			);
			expect(s2).toBe(false);

			const s3 = await recordTaskHistoryEvent(
				WORKSPACE_ID,
				"task-1",
				{ type: "session", agentId: "codex", agentSession: { agentId: "codex", id: "sess-2" } },
				() => now,
			);
			expect(s3).toBe(true);
		});
	});
});
