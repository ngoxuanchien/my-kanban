import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { shutdownRuntimeServer } from "../../src/server/shutdown-coordinator";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

async function withTemporaryHome<T>(run: () => Promise<T>): Promise<T> {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-shutdown-");
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

function runGit(path: string, args: string[]): void {
	const result = spawnSync("git", args, {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${path}`);
	}
}

function initGitRepository(path: string): void {
	runGit(path, ["init", "-b", "main"]);
	writeFileSync(join(path, "README.md"), "hello\n");
	runGit(path, ["add", "-A"]);
	runGit(path, ["commit", "-m", "init"]);
}

async function createTaskWorktreeWithUncommittedFile(repoPath: string, taskId: string): Promise<string> {
	const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "main" });
	if (!ensured.ok) {
		throw new Error(ensured.error ?? `Could not create worktree for ${taskId}`);
	}
	const filePath = join(ensured.path, "uncommitted.txt");
	writeFileSync(filePath, `work in progress for ${taskId}\n`);
	return filePath;
}

function columnTaskIds(board: RuntimeBoardData, columnId: string): string[] {
	return (board.columns.find((column) => column.id === columnId)?.cards ?? []).map((card) => card.id).sort();
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: { inProgress?: string[]; review?: string[] }): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{
				id: "in_progress",
				title: "In Progress",
				cards: (taskIds.inProgress ?? []).map((taskId) => createCard(taskId)),
			},
			{
				id: "review",
				title: "Review",
				cards: (taskIds.review ?? []).map((taskId) => createCard(taskId)),
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createSession(taskId: string, state: "running" | "awaiting_review" | "idle"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: `/tmp/${taskId}`,
		pid: state === "idle" ? null : 1234,
		startedAt: state === "idle" ? null : Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: state === "idle" ? null : Date.now(),
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe.sequential("shutdown coordinator integration", () => {
	it("stops agents but keeps every card in its column and every task worktree on disk", async () => {
		await withTemporaryHome(async () => {
			const { path: sandboxRoot, cleanup } = createTempDir("kanban-shutdown-scope-");
			try {
				const managedProjectPath = join(sandboxRoot, "managed-project");
				const indexedProjectPath = join(sandboxRoot, "indexed-project");
				mkdirSync(managedProjectPath, { recursive: true });
				mkdirSync(indexedProjectPath, { recursive: true });
				initGitRepository(managedProjectPath);
				initGitRepository(indexedProjectPath);

				const managedBoard = createBoard({
					inProgress: ["managed-running", "managed-missing-session"],
					review: ["managed-idle"],
				});
				const managedInitial = await loadWorkspaceState(managedProjectPath);
				await saveWorkspaceState(managedProjectPath, {
					board: managedBoard,
					sessions: {
						"managed-running": createSession("managed-running", "running"),
						"managed-idle": createSession("managed-idle", "idle"),
					},
					expectedRevision: managedInitial.revision,
				});

				const indexedBoard = createBoard({
					inProgress: ["indexed-missing-session"],
					review: ["indexed-awaiting-review"],
				});
				const indexedInitial = await loadWorkspaceState(indexedProjectPath);
				await saveWorkspaceState(indexedProjectPath, {
					board: indexedBoard,
					sessions: {
						"indexed-awaiting-review": createSession("indexed-awaiting-review", "awaiting_review"),
					},
					expectedRevision: indexedInitial.revision,
				});

				const uncommittedFiles = [
					...(await Promise.all(
						["managed-running", "managed-missing-session", "managed-idle"].map((taskId) =>
							createTaskWorktreeWithUncommittedFile(managedProjectPath, taskId),
						),
					)),
					...(await Promise.all(
						["indexed-missing-session", "indexed-awaiting-review"].map((taskId) =>
							createTaskWorktreeWithUncommittedFile(indexedProjectPath, taskId),
						),
					)),
				];

				let stopAllCalls = 0;
				let didCloseRuntimeServer = false;
				const managedTerminalManager = {
					markInterruptedAndStopAll: () => {
						stopAllCalls += 1;
						return [createSession("managed-running", "running")];
					},
				} as unknown as TerminalSessionManager;
				await shutdownRuntimeServer({
					workspaceRegistry: {
						listManagedWorkspaces: () => [
							{
								workspaceId: "managed-project",
								workspacePath: managedProjectPath,
								terminalManager: managedTerminalManager,
							},
						],
					},
					warn: () => {},
					closeRuntimeServer: async () => {
						didCloseRuntimeServer = true;
					},
				});

				expect(stopAllCalls).toBe(1);
				expect(didCloseRuntimeServer).toBe(true);

				const managedAfter = await loadWorkspaceState(managedProjectPath);
				expect(columnTaskIds(managedAfter.board, "in_progress")).toEqual(
					columnTaskIds(managedBoard, "in_progress"),
				);
				expect(columnTaskIds(managedAfter.board, "review")).toEqual(["managed-idle"]);
				expect(columnTaskIds(managedAfter.board, "trash")).toEqual([]);
				expect(managedAfter.sessions["managed-running"]?.state).toBe("running");
				expect(managedAfter.sessions["managed-idle"]?.state).toBe("idle");

				const indexedAfter = await loadWorkspaceState(indexedProjectPath);
				expect(columnTaskIds(indexedAfter.board, "in_progress")).toEqual(["indexed-missing-session"]);
				expect(columnTaskIds(indexedAfter.board, "review")).toEqual(["indexed-awaiting-review"]);
				expect(columnTaskIds(indexedAfter.board, "trash")).toEqual([]);
				expect(indexedAfter.sessions["indexed-awaiting-review"]?.state).toBe("awaiting_review");

				for (const filePath of uncommittedFiles) {
					expect(existsSync(filePath)).toBe(true);
					expect(readFileSync(filePath, "utf8")).toContain("work in progress");
				}
			} finally {
				cleanup();
			}
		});
	}, 30_000);
});
