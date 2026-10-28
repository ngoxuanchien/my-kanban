import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type {
	RuntimeStateStreamMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../../src/server/runtime-state-hub";

vi.mock("../../../src/server/workspace-metadata-monitor", () => ({
	createWorkspaceMetadataMonitor: () => ({
		connectWorkspace: async () => ({ homeGitSummary: null, taskWorkspaces: [] }),
		updateWorkspaceState: async () => ({ homeGitSummary: null, taskWorkspaces: [] }),
		disconnectWorkspace: () => {},
		disposeWorkspace: () => {},
		close: () => {},
	}),
}));

const WORKSPACE_ID = "workspace-1";

function createSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function nextTaskSessionsMessage(socket: WebSocket): Promise<RuntimeStateStreamTaskSessionsMessage> {
	return new Promise((resolve) => {
		const onMessage = (raw: Buffer) => {
			const message = JSON.parse(raw.toString("utf8")) as RuntimeStateStreamMessage;
			if (message.type === "task_sessions_updated") {
				socket.off("message", onMessage);
				resolve(message);
			}
		};
		socket.on("message", onMessage);
	});
}

describe("runtime state hub agent-review sessions", () => {
	let server: Server;
	let hub: RuntimeStateHub;
	let url: string;

	beforeEach(async () => {
		hub = createRuntimeStateHub({
			workspaceRegistry: {
				resolveWorkspaceForStream: vi.fn(async () => ({
					workspaceId: WORKSPACE_ID,
					workspacePath: "/tmp/repo",
					removedRequestedWorkspacePath: null,
					didPruneProjects: false,
				})),
				buildProjectsPayload: vi.fn(async () => ({ currentProjectId: WORKSPACE_ID, projects: [] })),
				buildWorkspaceStateSnapshot: vi.fn(async () => ({}) as never),
			},
		});
		server = createServer();
		server.on("upgrade", (request, socket, head) => {
			hub.handleUpgrade(request, socket, head, { requestedWorkspaceId: WORKSPACE_ID });
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await hub.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("does not broadcast agent-review Cline summaries", async () => {
		let emitSummary: (summary: RuntimeTaskSessionSummary) => void = () => {};
		const service = {
			listSummaries: () => [createSummary("t1"), createSummary("agent-review:t1")],
			onSummary: (listener: (summary: RuntimeTaskSessionSummary) => void) => {
				emitSummary = listener;
				return () => {};
			},
			onMessage: () => () => {},
		} as unknown as ClineTaskSessionService;
		hub.trackClineTaskSessionService(WORKSPACE_ID, "/tmp/repo", service);

		const socket = new WebSocket(url);
		const initial = nextTaskSessionsMessage(socket);
		await once(socket, "open");
		expect((await initial).summaries.map((summary) => summary.taskId)).toEqual(["t1"]);

		const live = nextTaskSessionsMessage(socket);
		emitSummary(createSummary("agent-review:t1"));
		emitSummary({ ...createSummary("t1"), state: "awaiting_review" });
		expect((await live).summaries.map((summary) => summary.taskId)).toEqual(["t1"]);

		socket.close();
		await once(socket, "close");
	});
});
