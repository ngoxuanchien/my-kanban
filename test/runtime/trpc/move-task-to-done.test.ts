import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard, RuntimeWorkspaceStateResponse } from "../../../src/core/api-contract";
import { loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

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

describe.sequential("workspace.moveTaskToDone", () => {
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
		spawnSync("git", ["init"], {
			cwd: workspacePath,
			stdio: "ignore",
			env: createGitTestEnv(),
		});
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		for (const cleanup of cleanups) cleanup();
	});

	it("moves the task under the workspace lock and broadcasts the saved state once", async () => {
		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, {
			board: {
				columns: [
					{ id: "backlog", title: "Backlog", cards: [createCard("B")] },
					{ id: "in_progress", title: "In Progress", cards: [] },
					{ id: "review", title: "Review", cards: [createCard("A")] },
					{ id: "trash", title: "Done", cards: [] },
				],
				dependencies: [{ id: "dep", fromTaskId: "B", toTaskId: "A", createdAt: 1 }],
			},
			sessions: {},
			expectedRevision: initial.revision,
		});
		const broadcast = vi.fn();
		const api = createWorkspaceApi({
			ensureTerminalManagerForWorkspace: vi.fn(async () => ({}) as never),
			getScopedClineTaskSessionService: vi.fn(async () => ({}) as never),
			broadcastRuntimeWorkspaceStateUpdated: broadcast,
			broadcastRuntimeProjectsUpdated: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(async () => ({}) as RuntimeWorkspaceStateResponse),
		});

		const result = await api.moveTaskToDone({ workspaceId: "workspace-1", workspacePath }, { taskId: "A" });
		const saved = await loadWorkspaceState(workspacePath);

		expect(result).toMatchObject({
			ok: true,
			moved: true,
			readyTaskIds: ["B"],
			state: { revision: 2 },
		});
		expect(saved.board.columns.find((column) => column.id === "trash")?.cards.map((card) => card.id)).toEqual(["A"]);
		expect(saved.revision).toBe(result.state.revision);
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(broadcast).toHaveBeenCalledWith("workspace-1", workspacePath);
	});
});
