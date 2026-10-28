import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { RESUME_AFTER_RESTART_PROMPT, resumeInterruptedTasks } from "../../../src/server/resume-interrupted-tasks";
import { loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../../../src/trpc/app-router";
import { ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
}

function createCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Do ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(inProgress: RuntimeBoardCard[], review: RuntimeBoardCard[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: inProgress },
			{ id: "review", title: "Review", cards: review },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function session(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		agentId: "codex",
		workspacePath: null,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe.sequential("resumeInterruptedTasks", () => {
	let repoPath = "";
	let cleanups: Array<() => void> = [];
	let previousHome: string | undefined;

	beforeEach(() => {
		const home = createTempDir("kanban-home-resume-");
		const sandbox = createTempDir("kanban-resume-");
		cleanups = [home.cleanup, sandbox.cleanup];
		previousHome = process.env.HOME;
		process.env.HOME = home.path;
		repoPath = join(sandbox.path, "project");
		mkdirSync(repoPath, { recursive: true });
		git(repoPath, ["init", "-b", "main"]);
		writeFileSync(join(repoPath, "README.md"), "hello\n");
		git(repoPath, ["add", "-A"]);
		git(repoPath, ["commit", "-m", "init"]);
	});

	afterEach(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		for (const cleanup of cleanups) {
			cleanup();
		}
	});

	it("relaunches In Progress agents in their worktrees with a continue prompt", async () => {
		for (const taskId of ["running", "no-session", "interrupted", "stopped", "in-review"]) {
			const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: repoPath, taskId, baseRef: "main" });
			expect(ensured.ok).toBe(true);
		}
		const initial = await loadWorkspaceState(repoPath);
		await saveWorkspaceState(repoPath, {
			board: createBoard(
				[
					createCard("running", { agentId: "opencode" }),
					createCard("no-session"),
					createCard("interrupted"),
					createCard("stopped"),
					createCard("worktree-gone"),
				],
				[createCard("in-review")],
			),
			sessions: {
				running: session("running", "running"),
				interrupted: session("interrupted", "interrupted"),
				stopped: session("stopped", "idle"),
			},
			expectedRevision: initial.revision,
		});

		const starts: Array<{ scope: RuntimeTrpcWorkspaceScope; request: RuntimeTaskSessionStartRequest }> = [];
		const warnings: string[] = [];
		await resumeInterruptedTasks({
			startTaskSession: async (scope, request) => {
				starts.push({ scope, request });
				return { ok: true, summary: null };
			},
			warn: (message) => warnings.push(message),
		});

		expect(starts.map(({ request }) => request.taskId)).toEqual(["running", "no-session", "interrupted"]);
		for (const { scope, request } of starts) {
			expect(scope.workspacePath).toBe(realpathSync(repoPath));
			expect(request).toMatchObject({
				prompt: RESUME_AFTER_RESTART_PROMPT,
				resumeFromPersistence: true,
				baseRef: "main",
			});
		}
		expect(starts[0]?.request.agentId).toBe("opencode");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("worktree-gone");
	});
});
