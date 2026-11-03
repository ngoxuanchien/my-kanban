import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordTaskHistoryEvent } from "../../src/state/task-history";
import type { RuntimeTrpcWorkspaceScope } from "../../src/trpc/app-router";
import { type CreateRuntimeApiDependencies, createRuntimeApi } from "../../src/trpc/runtime-api";
import { getTaskPatchFileChanges } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";

let temp = "";
const oldHome = process.env.HOME;

async function setup(): Promise<{ home: string; repo: string; scope: RuntimeTrpcWorkspaceScope }> {
	temp = await mkdtemp(join(tmpdir(), "task-history-api-"));
	const home = join(temp, "home");
	const repo = join(temp, "repo");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(repo, { recursive: true })]);
	process.env.HOME = home;
	for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Test"]]) {
		const result = spawnSync("git", args, { cwd: repo, stdio: "ignore", env: createGitTestEnv() });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
	}
	return { home, repo, scope: { workspaceId: "api-workspace", workspacePath: repo } };
}

function createApi() {
	return createRuntimeApi({} as unknown as CreateRuntimeApiDependencies);
}

afterEach(async () => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	if (temp) await rm(temp, { recursive: true, force: true });
	temp = "";
});

describe("task history runtime queries", () => {
	it("returns task events in timestamp order", async () => {
		const { scope } = await setup();
		await recordTaskHistoryEvent(
			scope.workspaceId,
			"task-1",
			{ type: "pass", agentId: "codex", commit: "abc" },
			() => 20,
		);
		await recordTaskHistoryEvent(scope.workspaceId, "task-1", { type: "started", agentId: "codex" }, () => 10);
		expect(await createApi().getTaskHistory(scope, { taskId: "task-1" })).toEqual({
			events: [
				{ type: "started", agentId: "codex", at: 10 },
				{ type: "pass", agentId: "codex", at: 20, commit: "abc" },
			],
		});
	});

	it("returns changed files for a real commit and notFound for an unknown hash", async () => {
		const { repo, scope } = await setup();
		await writeFile(join(repo, "one.txt"), "hello\n");
		spawnSync("git", ["add", "one.txt"], { cwd: repo, stdio: "ignore", env: createGitTestEnv() });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore", env: createGitTestEnv() });
		const commit = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
			env: createGitTestEnv(),
		}).stdout.trim();
		const api = createApi();
		const changes = await api.getCommitChanges(scope, { commit });
		expect("notFound" in changes ? changes : changes.files.map(({ path }) => path)).toContain("one.txt");
		expect(await api.getCommitChanges(scope, { commit: "deadbeef" })).toEqual({ notFound: true, commit: "deadbeef" });
	});

	it("returns saved patch changes for tracked and untracked files, or notFound without a patch", async () => {
		const { home, repo, scope } = await setup();
		await writeFile(join(repo, "tracked.txt"), "before\n");
		spawnSync("git", ["add", "tracked.txt"], { cwd: repo, stdio: "ignore", env: createGitTestEnv() });
		spawnSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore", env: createGitTestEnv() });
		const baseCommit = spawnSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
			env: createGitTestEnv(),
		}).stdout.trim();
		await writeFile(join(repo, "tracked.txt"), "after\n");
		await writeFile(join(repo, "new.txt"), "created\n");
		const trackedPatch = spawnSync("git", ["diff", "--binary", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
			env: createGitTestEnv(),
		}).stdout;
		const untrackedPatch = spawnSync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", "new.txt"], {
			cwd: repo,
			encoding: "utf8",
			env: createGitTestEnv(),
		}).stdout;
		const patchesDir = join(home, ".cline", "kanban", "trashed-task-patches");
		await mkdir(patchesDir, { recursive: true });
		await writeFile(join(patchesDir, `task-with-patch.${baseCommit}.patch`), `${trackedPatch}${untrackedPatch}`);

		const fileChanges = await getTaskPatchFileChanges({ repoPath: repo, taskId: "task-with-patch" });
		expect(fileChanges).toMatchObject([
			{ path: "new.txt", status: "added", oldText: null, newText: "created" },
			{ path: "tracked.txt", status: "modified", oldText: "before", newText: "after" },
		]);
		const changes = await createApi().getTaskPatchChanges(scope, { taskId: "task-with-patch" });
		expect(changes).toMatchObject({
			files: [
				{ path: "new.txt", status: "added", oldText: null, newText: "created" },
				{ path: "tracked.txt", status: "modified", oldText: "before", newText: "after" },
			],
		});
		expect(await getTaskPatchFileChanges({ repoPath: repo, taskId: "missing-patch" })).toEqual({ notFound: true });
		expect(await createApi().getTaskPatchChanges(scope, { taskId: "missing-patch" })).toEqual({ notFound: true });
	});

	it("looks up recorded session ids before reading transcript paths", async () => {
		const { home, scope } = await setup();
		const path = join(home, ".codex", "session.jsonl");
		await mkdir(join(home, ".codex"), { recursive: true });
		await writeFile(
			path,
			'{"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"hello"}]}}\n',
		);
		await recordTaskHistoryEvent(scope.workspaceId, "task-1", {
			type: "session",
			agentId: "codex",
			agentSession: { agentId: "codex", id: "session-1", transcriptPath: path },
		});
		expect(await createApi().getAgentTranscript(scope, { taskId: "task-1", sessionId: "session-1" })).toMatchObject({
			turns: [{ role: "user", text: "hello" }],
		});
	});

	it("refuses a transcript path outside the allowed agent homes", async () => {
		const { scope } = await setup();
		const path = join(temp, "outside.jsonl");
		await writeFile(
			path,
			'{"type":"response_item","payload":{"type":"message","role":"user","content":"private"}}\n',
		);
		await recordTaskHistoryEvent(scope.workspaceId, "task-1", {
			type: "session",
			agentId: "codex",
			agentSession: { agentId: "codex", id: "session-1", transcriptPath: path },
		});
		expect(await createApi().getAgentTranscript(scope, { taskId: "task-1", sessionId: "session-1" })).toEqual({
			unavailable: "path not allowed",
		});
	});
});
