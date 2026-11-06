import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAgentScoreEvent } from "../../../src/state/agent-scores";
import {
	EMPLOYEES_FILENAME,
	loadDeclaredEmployees,
	loadEmployeeProfiles,
	parseEmployeeKey,
	updateDeclaredEmployee,
} from "../../../src/state/employees";
import { recordTaskHistoryEvent } from "../../../src/state/task-history";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "employees-test-workspace";

async function withTemporaryHome<T>(run: (tempHome: string) => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-employees-home-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		return await run(tempHome);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		cleanup();
	}
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, env: createGitTestEnv(), encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function commitFile(repo: string, relativePath: string): string {
	const full = join(repo, relativePath);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, "x\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", `add ${relativePath}`]);
	return git(repo, ["rev-parse", "HEAD"]);
}

function employeesPath(): string {
	return join(getWorkspaceDirectoryPath(WORKSPACE_ID), EMPLOYEES_FILENAME);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseEmployeeKey", () => {
	it("splits agent and model", () => {
		expect(parseEmployeeKey("opus")).toEqual({ agentId: "claude", model: "opus" });
		expect(parseEmployeeKey("codex")).toEqual({ agentId: "codex", model: null });
		expect(parseEmployeeKey("codex:gpt-5")).toEqual({ agentId: "codex", model: "gpt-5" });
		expect(parseEmployeeKey("antigravity")).toEqual({ agentId: "antigravity", model: null });
	});
});

describe("declared employees", () => {
	it("falls back to {} and warns on malformed file", async () => {
		await withTemporaryHome(async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			mkdirSync(getWorkspaceDirectoryPath(WORKSPACE_ID), { recursive: true });
			writeFileSync(employeesPath(), "{not json");
			expect(await loadDeclaredEmployees(WORKSPACE_ID)).toEqual({});
			expect(warn).toHaveBeenCalled();
		});
	});

	it("keeps unknown top-level keys on write", async () => {
		await withTemporaryHome(async () => {
			mkdirSync(getWorkspaceDirectoryPath(WORKSPACE_ID), { recursive: true });
			writeFileSync(employeesPath(), JSON.stringify({ version: 1, employees: {}, extra: { a: 1 } }));
			const updated = await updateDeclaredEmployee(WORKSPACE_ID, "codex", { strong: ["web-ui"] });
			expect(updated).toEqual({ status: "active", strong: ["web-ui"], avoid: [], notes: "" });
			const raw = JSON.parse(readFileSync(employeesPath(), "utf8")) as Record<string, unknown>;
			expect(raw.extra).toEqual({ a: 1 });
			expect((await loadDeclaredEmployees(WORKSPACE_ID)).codex?.strong).toEqual(["web-ui"]);
		});
	});
});

describe("loadEmployeeProfiles", () => {
	it("derives areas from the pass commit and counts fails against them", async () => {
		await withTemporaryHome(async (tempHome) => {
			const repo = join(tempHome, "repo");
			mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			const commit = commitFile(repo, "web-ui/src/a.tsx");
			await recordAgentScoreEvent(WORKSPACE_ID, { type: "fail", agentId: "codex:gpt-5", taskId: "t1", round: 1 });
			await recordAgentScoreEvent(WORKSPACE_ID, { type: "pass", agentId: "codex:gpt-5", taskId: "t1", round: 2 });
			await recordTaskHistoryEvent(WORKSPACE_ID, "t1", { type: "pass", agentId: "codex", commit });

			const profiles = await loadEmployeeProfiles({ workspaceId: WORKSPACE_ID, repoPath: repo });
			expect(profiles).toHaveLength(1);
			expect(profiles[0]).toMatchObject({
				key: "codex:gpt-5",
				agentId: "codex",
				model: "gpt-5",
				status: "active",
				areas: { "web-ui": { passes: 1, fails: 1 } },
			});
		});
	});

	it("counts score but no areas when the commit is missing", async () => {
		await withTemporaryHome(async (tempHome) => {
			const repo = join(tempHome, "repo");
			mkdirSync(repo, { recursive: true });
			git(repo, ["init"]);
			commitFile(repo, "README.md");
			await recordAgentScoreEvent(WORKSPACE_ID, { type: "pass", agentId: "opencode", taskId: "t2" });
			await recordTaskHistoryEvent(WORKSPACE_ID, "t2", {
				type: "pass",
				agentId: "opencode",
				commit: "0123456789abcdef0123456789abcdef01234567",
			});

			const [profile] = await loadEmployeeProfiles({ workspaceId: WORKSPACE_ID, repoPath: repo });
			expect(profile?.areas).toEqual({});
			expect(profile?.score.passes).toBe(1);
		});
	});

	it("includes declared-only employees and merges legacy claude into opus", async () => {
		await withTemporaryHome(async (tempHome) => {
			await updateDeclaredEmployee(WORKSPACE_ID, "sonnet", { status: "inactive" });
			await recordAgentScoreEvent(WORKSPACE_ID, { type: "pass", agentId: "claude", taskId: "t3" });
			const profiles = await loadEmployeeProfiles({ workspaceId: WORKSPACE_ID, repoPath: tempHome });
			expect(profiles.map((p) => [p.key, p.status, p.agentId])).toEqual([
				["opus", "active", "claude"],
				["sonnet", "inactive", "claude"],
			]);
		});
	});
});
