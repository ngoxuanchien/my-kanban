import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
	type AgentScoreEvent,
	loadAgentScores,
	recordAgentScoreEvent,
	summarizeAgentScoreEvents,
} from "../../../src/state/agent-scores";
import { getWorkspacesRootPath, loadWorkspaceState } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "agent-scores-test-workspace";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-agent-scores-home-");
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

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

describe("agent scores", () => {
	it("merges legacy claude events into opus without counting a task twice", () => {
		expect(
			summarizeAgentScoreEvents([
				{ type: "assigned", agentId: "claude", taskId: "t1", at: 1 },
				{ type: "pass", agentId: "claude", taskId: "t1", at: 2 },
				{ type: "assigned", agentId: "opus", taskId: "t1", at: 3 },
				{ type: "pass", agentId: "opus", taskId: "t2", at: 4 },
			]),
		).toEqual([{ agentId: "opus", score: 2, passes: 2, fails: 0, tasks: 1 }]);
	});

	it("summarizes derived agent score totals from raw events", () => {
		expect(
			summarizeAgentScoreEvents([
				{ type: "assigned", agentId: "codex", taskId: "t1", at: 1 },
				{ type: "fail", agentId: "codex", taskId: "t1", round: 1, at: 2 },
				{ type: "fail", agentId: "codex", taskId: "t1", round: 2, at: 3 },
				{ type: "assigned", agentId: "opencode", taskId: "t1", at: 4 },
				{ type: "pass", agentId: "opencode", taskId: "t1", round: 3, at: 5 },
				{ type: "assigned", agentId: "antigravity", taskId: "t2", at: 6 },
			]),
		).toEqual([
			{ agentId: "opencode", score: 1, passes: 1, fails: 0, tasks: 1 },
			{ agentId: "antigravity", score: 0, passes: 0, fails: 0, tasks: 1 },
			{ agentId: "codex", score: -2, passes: 0, fails: 2, tasks: 1 },
		]);
	});

	it("records a fail once per task and round and auto-assigns the agent task", async () => {
		await withTemporaryHome(async () => {
			const first = await recordAgentScoreEvent(WORKSPACE_ID, {
				type: "fail",
				agentId: "codex",
				taskId: "t1",
				round: 1,
			});
			expect(first).toBe(true);

			const second = await recordAgentScoreEvent(WORKSPACE_ID, {
				type: "fail",
				agentId: "codex",
				taskId: "t1",
				round: 1,
			});
			expect(second).toBe(false);

			const scores = await loadAgentScores(WORKSPACE_ID);
			expect(scores).toEqual([{ agentId: "codex", score: -1, passes: 0, fails: 1, tasks: 1 }]);

			const raw = JSON.parse(
				readFileSync(join(getWorkspacesRootPath(), WORKSPACE_ID, "agent-scores.json"), "utf8"),
			) as { version: number; events: AgentScoreEvent[] };
			expect(raw.version).toBe(1);
			expect(raw.events).toHaveLength(2);
			expect(raw.events[0]?.type).toBe("assigned");
			expect(raw.events[0]?.agentId).toBe("codex");
			expect(raw.events[0]?.taskId).toBe("t1");
			expect(raw.events[1]?.type).toBe("fail");
		});
	});

	it("records a pass once per task and an assigned once per agent task", async () => {
		await withTemporaryHome(async () => {
			const firstPass = await recordAgentScoreEvent(WORKSPACE_ID, { type: "pass", agentId: "codex", taskId: "t2" });
			expect(firstPass).toBe(true);

			const secondPass = await recordAgentScoreEvent(WORKSPACE_ID, { type: "pass", agentId: "codex", taskId: "t2" });
			expect(secondPass).toBe(false);

			const secondAssigned = await recordAgentScoreEvent(WORKSPACE_ID, {
				type: "assigned",
				agentId: "codex",
				taskId: "t2",
			});
			expect(secondAssigned).toBe(false);

			const scores = await loadAgentScores(WORKSPACE_ID);
			expect(scores).toEqual([{ agentId: "codex", score: 1, passes: 1, fails: 0, tasks: 1 }]);
		});
	});

	it("appends concurrent agent score events for different tasks", async () => {
		await withTemporaryHome(async () => {
			const [firstResult, secondResult] = await Promise.all([
				recordAgentScoreEvent(WORKSPACE_ID, { type: "assigned", agentId: "codex", taskId: "t1" }),
				recordAgentScoreEvent(WORKSPACE_ID, { type: "assigned", agentId: "codex", taskId: "t2" }),
			]);
			expect(firstResult).toBe(true);
			expect(secondResult).toBe(true);

			const raw = JSON.parse(
				readFileSync(join(getWorkspacesRootPath(), WORKSPACE_ID, "agent-scores.json"), "utf8"),
			) as { version: number; events: AgentScoreEvent[] };
			expect(raw.version).toBe(1);
			expect(raw.events).toHaveLength(2);
		});
	});

	it("returns empty scores for a missing file and tolerates a corrupt file", async () => {
		await withTemporaryHome(async () => {
			expect(await loadAgentScores(WORKSPACE_ID)).toEqual([]);

			mkdirSync(join(getWorkspacesRootPath(), WORKSPACE_ID), { recursive: true });
			writeFileSync(join(getWorkspacesRootPath(), WORKSPACE_ID, "agent-scores.json"), "not json", "utf8");
			expect(await loadAgentScores(WORKSPACE_ID)).toEqual([]);
		});
	});

	it("includes derived agent scores in the workspace state response", async () => {
		await withTemporaryHome(async () => {
			const workspacePath = join(getWorkspacesRootPath(), "project-agent-scores");
			mkdirSync(workspacePath, { recursive: true });
			initGitRepository(workspacePath);

			const state = await loadWorkspaceState(workspacePath);
			expect(state.agentScores).toEqual([]);
		});
	});
});
