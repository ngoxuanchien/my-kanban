import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TaskHistoryEvent } from "../../../src/state/task-history";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { type CreateHooksApiDependencies, createHooksApi } from "../../../src/trpc/hooks-api";

let testHome = "";
const previousHome = process.env.HOME;

async function prepareHome(): Promise<string> {
	testHome = await mkdtemp(join(tmpdir(), "hooks-api-home-"));
	process.env.HOME = testHome;
	return testHome;
}

afterEach(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (testHome) await rm(testHome, { recursive: true, force: true });
	testHome = "";
});

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

function createCaptureApi(
	recordHistory: NonNullable<CreateHooksApiDependencies["recordTaskHistoryEvent"]>,
	agentId: "codex" | "claude" | "antigravity",
) {
	const manager = {
		getSummary: vi.fn(() => createSummary({ state: "running", agentId })),
		transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
		transitionToRunning: vi.fn(),
		applyHookActivity: vi.fn(),
		applyTurnCheckpoint: vi.fn(),
	} as unknown as TerminalSessionManager;
	const api = createHooksApi({
		getWorkspacePathById: vi.fn(() => "/tmp/worktree"),
		ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastTaskReadyForReview: vi.fn(),
		captureTaskTurnCheckpoint: vi.fn(async () => ({ turn: 1, ref: "ref", commit: "commit", createdAt: 1 })),
		recordTaskHistoryEvent: recordHistory,
	});
	return { api, manager };
}

async function createTranscript(agentId: "codex" | "claude" | "antigravity"): Promise<{
	metadata: { source: string; conversationId?: string; transcriptPath?: string };
	expectedId: string;
	transcriptPath: string;
}> {
	const home = await prepareHome();
	const workspacePath = "/tmp/worktree";
	const date = new Date();
	const datePath = join(
		String(date.getFullYear()),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	);
	const projectDir =
		agentId === "codex"
			? join(home, ".codex", "sessions", datePath)
			: agentId === "claude"
				? join(home, ".claude", "projects", resolve(workspacePath).replaceAll(/[/.]/gu, "-"))
				: join(home, ".gemini", "antigravity-cli", "sessions");
	await mkdir(projectDir, { recursive: true });
	const transcriptPath = join(projectDir, "session.jsonl");
	const expectedId = agentId === "codex" ? "codex-session" : agentId === "claude" ? "claude-session" : "agy-session";
	const first =
		agentId === "codex"
			? { type: "session_meta", payload: { cwd: workspacePath, session_id: expectedId } }
			: agentId === "claude"
				? { type: "user", cwd: workspacePath, sessionId: expectedId }
				: { type: "USER_INPUT", cwd: workspacePath };
	await writeFile(transcriptPath, `${JSON.stringify(first)}\n{}\n`);
	const recordedPath = agentId === "antigravity" ? await realpath(transcriptPath) : transcriptPath;
	return {
		metadata: {
			source: agentId,
			...(agentId === "antigravity" ? { conversationId: expectedId, transcriptPath } : {}),
		},
		expectedId,
		transcriptPath: recordedPath,
	};
}

describe("createHooksApi", () => {
	it.each(["codex", "claude", "antigravity"] as const)(
		"records the %s session from a to_review hook",
		async (agentId) => {
			const transcript = await createTranscript(agentId);
			const recordHistory = vi.fn(
				async (_workspaceId: string, _taskId: string, _event: Omit<TaskHistoryEvent, "at">) => true,
			);
			const { api } = createCaptureApi(recordHistory, agentId);
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
				metadata: transcript.metadata,
			});

			expect(response).toEqual({ ok: true });
			await vi.waitFor(() => expect(recordHistory).toHaveBeenCalledTimes(1));
			expect(recordHistory).toHaveBeenCalledWith("workspace-1", "task-1", {
				type: "session",
				agentId,
				agentSession: { agentId, id: transcript.expectedId, transcriptPath: transcript.transcriptPath },
			});
		},
	);

	it("returns from the hook transition without waiting for session history recording", async () => {
		const transcript = await createTranscript("antigravity");
		let releaseRecord!: () => void;
		let recordingFinished = false;
		const pendingRecord = new Promise<boolean>((resolveRecord) => {
			releaseRecord = () => resolveRecord(true);
		});
		const recordHistory = vi.fn(
			async (_workspaceId: string, _taskId: string, _event: Omit<TaskHistoryEvent, "at">) => {
				await pendingRecord;
				recordingFinished = true;
				return true;
			},
		);
		const { api, manager } = createCaptureApi(recordHistory, "antigravity");

		try {
			const response = await api.ingest({
				taskId: "task-1",
				workspaceId: "workspace-1",
				event: "to_review",
				metadata: transcript.metadata,
			});
			expect(response).toEqual({ ok: true });
			expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook");
			await vi.waitFor(() => expect(recordHistory).toHaveBeenCalledOnce());
			expect(recordingFinished).toBe(false);
		} finally {
			releaseRecord();
		}
	});

	it("treats ineligible hook transitions as successful no-ops", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_in_progress",
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
	});

	it("stores activity metadata without changing session state", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "activity",
			metadata: {
				source: "claude",
				activityText: "Using Read",
			},
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToRunning).not.toHaveBeenCalled();
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "claude",
			activityText: "Using Read",
		});
	});

	it("captures a turn checkpoint when transitioning to review", async () => {
		const transitionedSummary = createSummary({
			state: "awaiting_review",
			reviewReason: "hook",
			latestTurnCheckpoint: {
				turn: 2,
				ref: "refs/kanban/checkpoints/task-1/turn/2",
				commit: "2222222",
				createdAt: 1,
			},
			previousTurnCheckpoint: {
				turn: 1,
				ref: "refs/kanban/checkpoints/task-1/turn/1",
				commit: "1111111",
				createdAt: 1,
			},
		});

		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running" })),
			transitionToReview: vi.fn(() => transitionedSummary),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;

		const captureTaskTurnCheckpoint = vi.fn(async () => ({
			turn: 3,
			ref: "refs/kanban/checkpoints/task-1/turn/3",
			commit: "3333333",
			createdAt: Date.now(),
		}));
		const deleteTaskTurnCheckpointRef = vi.fn(async () => undefined);

		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview: vi.fn(),
			captureTaskTurnCheckpoint,
			deleteTaskTurnCheckpointRef,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
		});

		expect(response).toEqual({ ok: true });
		expect(captureTaskTurnCheckpoint).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			taskId: "task-1",
			turn: 3,
		});
		expect(manager.applyTurnCheckpoint).toHaveBeenCalledTimes(1);
		expect(deleteTaskTurnCheckpointRef).toHaveBeenCalledWith({
			cwd: "/tmp/worktree",
			ref: "refs/kanban/checkpoints/task-1/turn/1",
		});
	});

	// The board moves the card to Review when it sees awaiting_review; Antigravity needs no server-side move.
	it("handles Antigravity to_review through the same path as other agents", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "antigravity" })),
			transitionToReview: vi.fn(() => createSummary({ state: "awaiting_review", reviewReason: "hook" })),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
			applyTurnCheckpoint: vi.fn(),
		} as unknown as TerminalSessionManager;
		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
			captureTaskTurnCheckpoint: vi.fn(async () => {
				throw new Error("skip checkpoint");
			}),
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "antigravity", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).toHaveBeenCalledWith("task-1", "hook");
		expect(manager.applyHookActivity).toHaveBeenCalledWith("task-1", {
			source: "antigravity",
			hookEventName: "Stop",
		});
		expect(broadcastTaskReadyForReview).toHaveBeenCalledWith("workspace-1", "task-1");
	});

	it("ignores a delayed to_review hook from the agent stopped during handoff", async () => {
		const manager = {
			getSummary: vi.fn(() => createSummary({ state: "running", agentId: "codex" })),
			transitionToReview: vi.fn(),
			transitionToRunning: vi.fn(),
			applyHookActivity: vi.fn(),
		} as unknown as TerminalSessionManager;
		const broadcastTaskReadyForReview = vi.fn();
		const api = createHooksApi({
			getWorkspacePathById: vi.fn(() => "/tmp/repo"),
			ensureTerminalManagerForWorkspace: vi.fn(async () => manager),
			broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
			broadcastTaskReadyForReview,
		});

		const response = await api.ingest({
			taskId: "task-1",
			workspaceId: "workspace-1",
			event: "to_review",
			metadata: { source: "antigravity", hookEventName: "Stop" },
		});

		expect(response).toEqual({ ok: true });
		expect(manager.transitionToReview).not.toHaveBeenCalled();
		expect(manager.applyHookActivity).not.toHaveBeenCalled();
		expect(broadcastTaskReadyForReview).not.toHaveBeenCalled();
	});
});
