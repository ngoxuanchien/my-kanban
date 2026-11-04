import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createRuntimeStateHub } from "../../../src/server/runtime-state-hub";

vi.mock("../../../src/server/workspace-metadata-monitor", () => ({
	createWorkspaceMetadataMonitor: () => ({
		connectWorkspace: async () => ({ homeGitSummary: null, homeGitStateVersion: 0, taskWorkspaces: [] }),
		disconnectWorkspace: () => {},
		close: () => {},
	}),
}));

it("broadcasts a permission reason and omits reason for a plain turn end", async () => {
	const hub = createRuntimeStateHub({
		workspaceRegistry: {
			resolveWorkspaceForStream: async () => ({
				workspaceId: "workspace-1",
				workspacePath: "/repo",
				removedRequestedWorkspacePath: null,
				didPruneProjects: false,
			}),
			buildProjectsPayload: async () => ({ currentProjectId: "workspace-1", projects: [] }),
			buildWorkspaceStateSnapshot: async () => ({
				repoPath: "/repo",
				statePath: "/state",
				git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
				board: { columns: [], dependencies: [] },
				sessions: {},
				revision: 0,
			}),
		},
	});
	const server = createServer();
	server.on("upgrade", (request, socket, head) => {
		hub.handleUpgrade(request, socket, head, { requestedWorkspaceId: "workspace-1" });
	});
	let client: WebSocket | undefined;
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected server port");
		client = new WebSocket(`ws://127.0.0.1:${address.port}`);
		await once(client, "message");

		const permissionMessage = once(client, "message");
		hub.broadcastTaskReadyForReview("workspace-1", "task-1", "permission");
		const [permission] = await permissionMessage;
		expect(JSON.parse(permission.toString())).toEqual({
			type: "task_ready_for_review",
			workspaceId: "workspace-1",
			taskId: "task-1",
			triggeredAt: expect.any(Number),
			reason: "permission",
		});

		const reviewMessage = once(client, "message");
		hub.broadcastTaskReadyForReview("workspace-1", "task-1");
		const [review] = await reviewMessage;
		expect(JSON.parse(review.toString())).toEqual({
			type: "task_ready_for_review",
			workspaceId: "workspace-1",
			taskId: "task-1",
			triggeredAt: expect.any(Number),
		});
	} finally {
		client?.terminate();
		await hub.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
