import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { type CompleteTaskToDoneDeps, completeTaskToDone } from "../../src/workspace/complete-task-to-done";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function createCard(id: string): RuntimeBoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(cardA: RuntimeBoardCard, cardAColumnId: RuntimeBoardColumnId): RuntimeBoardData {
	const columns: RuntimeBoardData["columns"] = [
		{ id: "backlog", title: "Backlog", cards: [createCard("B")] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "user_review", title: "Needs your review", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	return {
		columns: columns.map((column) =>
			column.id === cardAColumnId ? { ...column, cards: [...column.cards, cardA] } : column,
		),
		dependencies: [{ id: "dep-1", fromTaskId: "B", toTaskId: "A", createdAt: 1 }],
	};
}

function createRecordingDeps(calls: string[]): CompleteTaskToDoneDeps {
	return {
		stopTaskSession: async () => {
			calls.push("stop");
		},
		startTask: async (taskId) => {
			calls.push(`start:${taskId}`);
			return { id: taskId };
		},
		deleteTaskWorktree: async () => {
			calls.push("delete");
			return { removed: true };
		},
		notifyStateUpdated: async () => {
			calls.push("notify");
		},
	};
}

describe.sequential("completeTaskToDone", () => {
	let workspacePath = "";
	let cleanups: Array<() => void> = [];
	let previousHome: string | undefined;
	let previousUserProfile: string | undefined;

	beforeEach(() => {
		const home = createTempDir("kanban-home-");
		const sandbox = createTempDir("kanban-workspace-");
		cleanups = [home.cleanup, sandbox.cleanup];
		previousHome = process.env.HOME;
		previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		workspacePath = join(sandbox.path, "project");
		mkdirSync(workspacePath, { recursive: true });
		spawnSync("git", ["init"], { cwd: workspacePath, stdio: "ignore", env: createGitTestEnv() });
	});

	afterEach(() => {
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
		for (const cleanup of cleanups) {
			cleanup();
		}
	});

	async function seedBoard(columnId: RuntimeBoardColumnId): Promise<number> {
		const initial = await loadWorkspaceState(workspacePath);
		const saved = await saveWorkspaceState(workspacePath, {
			board: createBoard(createCard("A"), columnId),
			sessions: {},
			expectedRevision: initial.revision,
		});
		return saved.revision;
	}

	it("moves the card to trash, then stops the session, starts dependents, deletes the worktree, in that order", async () => {
		await seedBoard("review");
		const calls: string[] = [];

		const result = await completeTaskToDone({
			repoPath: workspacePath,
			taskId: "A",
			deps: createRecordingDeps(calls),
		});

		expect(calls).toEqual(["notify", "stop", "start:B", "delete"]);
		expect(result.previousColumnId).toBe("review");
		expect(result.alreadyInTrash).toBe(false);
		expect(result.readyTaskIds).toEqual(["B"]);
		expect(result.autoStartedTasks).toEqual([{ id: "B" }]);
		expect(result.worktreeDeleted).toBe(true);
		const state = await loadWorkspaceState(workspacePath);
		expect(state.board.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual(["A"]);
	});

	it("applies beforeMove inside the same board write", async () => {
		const seededRevision = await seedBoard("review");

		const result = await completeTaskToDone({
			repoPath: workspacePath,
			taskId: "A",
			deps: createRecordingDeps([]),
			beforeMove: (card) => ({
				...card,
				agentReview: {
					status: "passed",
					round: 0,
					reason: null,
					reasonDetail: null,
					fingerprint: null,
					lastResult: null,
					fixPrompts: [],
					summary: null,
					meta: { commitHash: "abc123", prUrl: null, rounds: 0, reviewerAgentId: "claude", reviewedAt: 1 },
					updatedAt: 1,
				},
			}),
		});

		const state = await loadWorkspaceState(workspacePath);
		const trashed = state.board.columns.find((column) => column.id === "trash")?.cards[0];
		expect(trashed?.agentReview?.meta?.commitHash).toBe("abc123");
		expect(result.task?.agentReview?.meta?.commitHash).toBe("abc123");
		expect(state.revision).toBe(seededRevision + 1);
	});

	it("is a no-op when the task is already in trash", async () => {
		const seededRevision = await seedBoard("trash");
		const calls: string[] = [];

		const result = await completeTaskToDone({
			repoPath: workspacePath,
			taskId: "A",
			deps: createRecordingDeps(calls),
		});

		expect(result.alreadyInTrash).toBe(true);
		expect(result.previousColumnId).toBe("trash");
		expect(calls).toEqual([]);
		expect((await loadWorkspaceState(workspacePath)).revision).toBe(seededRevision);
	});

	it("starts dependents when moved from user_review", async () => {
		await seedBoard("user_review");
		const calls: string[] = [];

		const result = await completeTaskToDone({
			repoPath: workspacePath,
			taskId: "A",
			deps: createRecordingDeps(calls),
		});

		expect(result.previousColumnId).toBe("user_review");
		expect(result.readyTaskIds).toEqual(["B"]);
		expect(calls).toEqual(["notify", "stop", "start:B", "delete"]);
	});
});
