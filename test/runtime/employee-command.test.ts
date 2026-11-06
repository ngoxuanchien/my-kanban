import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEmployeeCommand } from "../../src/commands/employee";
import { recordAgentScoreEvent } from "../../src/state/agent-scores";
import { EMPLOYEES_FILENAME } from "../../src/state/employees";
import { recordTaskHistoryEvent } from "../../src/state/task-history";
import { getWorkspaceDirectoryPath, loadWorkspaceContext } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

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

interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runEmployee(repo: string, args: string[]): Promise<CommandResult> {
	let stdout = "";
	let stderr = "";
	vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		stdout += String(chunk);
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		stderr += String(chunk);
		return true;
	});
	process.exitCode = undefined;
	const program = new Command();
	registerEmployeeCommand(program);
	await program.parseAsync(["node", "kanban", "employee", ...args, "--project-path", repo]);
	const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
	process.exitCode = undefined;
	return { stdout, stderr, exitCode };
}

async function withRepo<T>(run: (repo: string, workspaceId: string) => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-employee-cmd-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		const repo = join(tempHome, "repo");
		mkdirSync(repo, { recursive: true });
		git(repo, ["init"]);
		git(repo, ["config", "user.email", "t@example.com"]);
		git(repo, ["config", "user.name", "Test"]);
		commitFile(repo, "README.md");
		const context = await loadWorkspaceContext(repo, { autoCreateIfMissing: true });
		return await run(repo, context.workspaceId);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		cleanup();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

describe("employee command", () => {
	it("set --strong shows +area in list", async () => {
		await withRepo(async (repo) => {
			const set = await runEmployee(repo, ["set", "--employee", "codex:gpt-5", "--strong", "web-ui"]);
			expect(set.exitCode).toBe(0);
			const list = await runEmployee(repo, ["list"]);
			const line = list.stdout.split("\n").find((entry) => entry.startsWith("codex:gpt-5"));
			expect(line).toContain("+web-ui");
		});
	});

	it("set with an unknown area exits 1, lists valid areas and leaves the file unchanged", async () => {
		await withRepo(async (repo, workspaceId) => {
			const path = join(getWorkspaceDirectoryPath(workspaceId), EMPLOYEES_FILENAME);
			await runEmployee(repo, ["set", "--employee", "codex:gpt-5", "--strong", "web-ui"]);
			const before = readFileSync(path, "utf8");
			const result = await runEmployee(repo, ["set", "--employee", "codex:gpt-5", "--strong", "bogus"]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("bogus");
			expect(result.stderr).toContain("web-ui");
			expect(result.stderr).toContain("runtime-other");
			expect(readFileSync(path, "utf8")).toBe(before);
		});
	});

	it("set with an unknown area creates no file when none existed", async () => {
		await withRepo(async (repo, workspaceId) => {
			const result = await runEmployee(repo, ["set", "--employee", "codex", "--avoid", "nope"]);
			expect(result.exitCode).toBe(1);
			expect(existsSync(join(getWorkspaceDirectoryPath(workspaceId), EMPLOYEES_FILENAME))).toBe(false);
		});
	});

	it("rank puts the employee with the best area record first", async () => {
		await withRepo(async (repo, workspaceId) => {
			const commit = commitFile(repo, "web-ui/src/a.tsx");
			await recordAgentScoreEvent(workspaceId, { type: "pass", agentId: "codex:gpt-5", taskId: "t1" });
			await recordTaskHistoryEvent(workspaceId, "t1", { type: "pass", agentId: "codex:gpt-5", commit });
			const result = await runEmployee(repo, ["rank", "--area", "web-ui", "--difficulty", "2"]);
			expect(result.exitCode).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines.length).toBeLessThanOrEqual(5);
			expect(lines[0]).toMatch(/--agent-id codex --model gpt-5$/);
		});
	});

	it("rank skips Claude by default and includes it with --all-agents", async () => {
		await withRepo(async (repo, workspaceId) => {
			const webCommit = commitFile(repo, "web-ui/src/a.tsx");
			const otherCommit = commitFile(repo, "web-ui/src/b.tsx");
			await recordAgentScoreEvent(workspaceId, { type: "pass", agentId: "codex:gpt-5", taskId: "t1" });
			await recordTaskHistoryEvent(workspaceId, "t1", { type: "pass", agentId: "codex:gpt-5", commit: webCommit });
			await recordAgentScoreEvent(workspaceId, { type: "pass", agentId: "opus", taskId: "t2" });
			await recordTaskHistoryEvent(workspaceId, "t2", { type: "pass", agentId: "opus", commit: otherCommit });
			await recordAgentScoreEvent(workspaceId, { type: "pass", agentId: "opus", taskId: "t3" });
			await recordTaskHistoryEvent(workspaceId, "t3", { type: "pass", agentId: "opus", commit: otherCommit });
			const args = ["rank", "--area", "web-ui", "--difficulty", "2"];
			const byDefault = await runEmployee(repo, args);
			expect(byDefault.stdout.split("\n")[0]).toMatch(/^codex:gpt-5 /);
			expect(byDefault.stdout).not.toContain("--agent-id claude");
			const all = await runEmployee(repo, [...args, "--all-agents"]);
			expect(all.stdout).toContain("--agent-id claude --model opus");
		});
	});

	it("rank with no data prints the fallback and exits 0", async () => {
		await withRepo(async (repo) => {
			const result = await runEmployee(repo, ["rank", "--area", "web-ui", "--difficulty", "2"]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("no data: use the rotation rule");
		});
	});

	it("rank rejects a difficulty outside 1-5", async () => {
		await withRepo(async (repo) => {
			const result = await runEmployee(repo, ["rank", "--area", "web-ui", "--difficulty", "9"]);
			expect(result.exitCode).toBe(1);
		});
	});
});
