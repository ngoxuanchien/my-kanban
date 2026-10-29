import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { SendPromptToSessionResult } from "../../../src/terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

const workspaceState = vi.hoisted(() => ({
	board: {
		columns: [
			{
				id: "review",
				title: "Review",
				cards: [
					{
						id: "task-1",
						title: "Task one",
						prompt: "Do it",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 0,
						updatedAt: 0,
						agentReviewEnabled: true,
						reviewRound: 0,
					},
					{
						id: "task-2",
						title: "Task two",
						prompt: "Do it",
						baseRef: "main",
						startInPlanMode: false,
						createdAt: 0,
						updatedAt: 0,
						agentReviewEnabled: true,
						reviewRound: 0,
					},
				],
			},
		],
	},
}));

const sendPromptToSession = vi.hoisted(() =>
	vi.fn(async (_input: { prompt: string }): Promise<SendPromptToSessionResult> => ({ ok: true })),
);

vi.mock("../../../src/state/workspace-state", () => ({
	loadWorkspaceState: vi.fn(async () => ({ board: workspaceState.board })),
	mutateWorkspaceState: vi.fn(
		async (
			_path: string,
			mutate: (state: { board: typeof workspaceState.board }) => {
				board: typeof workspaceState.board;
				value: unknown;
				save?: boolean;
			},
		) => {
			const result = mutate({ board: workspaceState.board });
			if (result.save !== false) workspaceState.board = result.board;
			return { saved: result.save !== false, value: result.value };
		},
	),
}));

vi.mock("../../../src/terminal/send-prompt-to-session", () => ({ sendPromptToSession }));

import { createSidebarReviewService } from "../../../src/server/sidebar-review-service";

function summary(taskId: string, state: RuntimeTaskSessionSummary["state"]): RuntimeTaskSessionSummary {
	return {
		taskId,
		state,
		mode: null,
		agentId: "claude",
		workspacePath: "/repo",
		pid: 123,
		startedAt: 0,
		updatedAt: Date.now(),
		lastOutputAt: null,
		reviewReason: state === "awaiting_review" ? "hook" : null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("createSidebarReviewService", () => {
	beforeEach(() => {
		workspaceState.board.columns[0].cards[0].reviewRound = 0;
		workspaceState.board.columns[0].cards[1].reviewRound = 0;
		sendPromptToSession.mockClear();
	});

	it("waits for the running sidebar's turn to end before sending one review", async () => {
		const terminalListeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const clineListeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				terminalListeners.add(listener);
				return () => terminalListeners.delete(listener);
			},
		};
		const clineService = {
			listSummaries: () => [],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				clineListeners.add(listener);
				return () => clineListeners.delete(listener);
			},
		};
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
		});
		await service.start();

		for (const listener of terminalListeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		expect(sendPromptToSession).not.toHaveBeenCalled();

		for (const listener of terminalListeners)
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "__home_agent__:workspace-1:claude",
				prompt: '[Kanban review] Task task-1 "Task one" is in Review, round 1/3. Review it now.',
			}),
		);
		service.dispose();
	});

	it("sends simultaneous task reviews in separate sidebar idle periods", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [
				summary("task-1", "running"),
				summary("task-2", "running"),
				summary("__home_agent__:workspace-1:claude", "awaiting_review"),
			],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
		});
		await service.start();
		for (const listener of listeners) {
			listener(summary("task-1", "awaiting_review"));
			listener(summary("task-2", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(sendPromptToSession).toHaveBeenCalledTimes(1);

		for (const listener of listeners) {
			listener(summary("__home_agent__:workspace-1:claude", "running"));
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(sendPromptToSession.mock.calls[0]?.[0].prompt).toContain("Task task-1");
		expect(sendPromptToSession.mock.calls[1]?.[0].prompt).toContain("Task task-2");
		service.dispose();
	});

	it("retries the same task after a failed send on the next sidebar idle", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [
				summary("task-1", "running"),
				summary("__home_agent__:workspace-1:claude", "awaiting_review"),
			],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId: "claude" }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
		});
		sendPromptToSession.mockResolvedValueOnce({ ok: false, reason: "session_not_running" });
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		const firstPrompt = sendPromptToSession.mock.calls[0]?.[0].prompt;

		for (const listener of listeners) {
			listener(summary("__home_agent__:workspace-1:claude", "running"));
			listener(summary("__home_agent__:workspace-1:claude", "awaiting_review"));
		}
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(2));
		expect(sendPromptToSession.mock.calls[1]?.[0].prompt).toBe(firstPrompt);
		service.dispose();
	});

	it("uses the currently selected sidebar agent when delivering", async () => {
		const listeners = new Set<(value: RuntimeTaskSessionSummary) => void>();
		const terminalManager = {
			listSummaries: () => [summary("task-1", "running"), summary("__home_agent__:workspace-1:claude", "running")],
			onSummary: (listener: (value: RuntimeTaskSessionSummary) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		};
		const clineService = { listSummaries: () => [], onSummary: () => () => {} };
		let selectedAgentId: RuntimeConfigState["selectedAgentId"] = "claude";
		const service = createSidebarReviewService({
			workspaceId: "workspace-1",
			workspacePath: "/repo",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			loadRuntimeConfig: async () => ({ selectedAgentId }) as RuntimeConfigState,
			broadcastStateUpdated: vi.fn(),
			warn: vi.fn(),
		});
		await service.start();
		for (const listener of listeners) listener(summary("task-1", "awaiting_review"));
		await vi.waitFor(() => expect(workspaceState.board.columns[0].cards[0].reviewRound).toBe(1));
		selectedAgentId = "codex";
		for (const listener of listeners) listener(summary("__home_agent__:workspace-1:codex", "awaiting_review"));
		await vi.waitFor(() => expect(sendPromptToSession).toHaveBeenCalledTimes(1));
		expect(sendPromptToSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "__home_agent__:workspace-1:codex",
				agentId: "codex",
			}),
		);
		service.dispose();
	});
});
