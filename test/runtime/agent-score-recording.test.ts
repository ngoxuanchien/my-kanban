import { beforeEach, describe, expect, it, vi } from "vitest";

interface ScoreEvent {
	type: string;
	agentId: string;
	taskId: string;
	round?: number;
}

const mocks = vi.hoisted(() => ({
	board: { columns: [] as Array<{ id: string; title: string; cards: unknown[] }> },
	loadWorkspaceBoardById: vi.fn(),
	events: [] as ScoreEvent[],
	recordAgentScoreEvent: vi.fn(async (_workspaceId: string, event: ScoreEvent) => {
		const eventKey = (candidate: ScoreEvent) =>
			`${candidate.type}:${candidate.agentId}:${candidate.taskId}:${candidate.type === "fail" ? candidate.round : ""}`;
		if (mocks.events.some((existing) => eventKey(existing) === eventKey(event))) {
			return false;
		}
		mocks.events.push(event);
		return true;
	}),
	notifyStateUpdated: vi.fn(),
	handOffTask: vi.fn(),
	broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
	resolveTaskCwd: vi.fn(),
	captureTaskTurnCheckpoint: vi.fn(),
	resolveAgentCommand: vi.fn(),
	sendPromptToSession: vi.fn(),
}));

vi.mock("../../src/state/workspace-state", () => ({
	loadWorkspaceBoardById: mocks.loadWorkspaceBoardById,
}));
vi.mock("../../src/state/agent-scores", () => ({
	recordAgentScoreEvent: mocks.recordAgentScoreEvent,
}));
vi.mock("../../src/workspace/task-worktree", () => ({ resolveTaskCwd: mocks.resolveTaskCwd }));
vi.mock("../../src/workspace/turn-checkpoints", () => ({ captureTaskTurnCheckpoint: mocks.captureTaskTurnCheckpoint }));
vi.mock("../../src/terminal/agent-registry", () => ({
	resolveAgentCommand: mocks.resolveAgentCommand,
	buildRuntimeConfigResponse: vi.fn(),
}));
vi.mock("../../src/terminal/send-prompt-to-session", () => ({ sendPromptToSession: mocks.sendPromptToSession }));
vi.mock("../../src/cline-sdk/cline-provider-service", () => ({ createClineProviderService: () => ({}) }));
vi.mock("../../src/cline-sdk/cline-mcp-settings-service", () => ({ createClineMcpSettingsService: () => ({}) }));
vi.mock("../../src/cline-sdk/cline-mcp-runtime-service", () => ({ createClineMcpRuntimeService: () => ({}) }));

import { runtimeAppRouter } from "../../src/trpc/app-router";
import { createRuntimeApi as createRuntimeApiImpl } from "../../src/trpc/runtime-api";

const scope = { workspaceId: "workspace-1", workspacePath: "/tmp/workspace" };
const reviewCard = {
	id: "task-1",
	agentId: "codex",
	agentReviewEnabled: true,
	reviewRound: 2,
};

function setBoard(columnId: string, card: Record<string, unknown>) {
	mocks.board.columns = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: columnId === "in_progress" ? [card] : [] },
		{ id: "review", title: "Review", cards: columnId === "review" ? [card] : [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	mocks.loadWorkspaceBoardById.mockResolvedValue(mocks.board);
}

function createCaller() {
	return runtimeAppRouter.createCaller({
		requestedWorkspaceId: scope.workspaceId,
		workspaceScope: scope,
		runtimeApi: { handOffTask: mocks.handOffTask },
		workspaceApi: { notifyStateUpdated: mocks.notifyStateUpdated },
	} as never);
}

function createRuntimeApi(terminalManager: Record<string, unknown> = {}) {
	return createRuntimeApiImpl({
		getActiveWorkspaceId: () => scope.workspaceId,
		loadScopedRuntimeConfig: async () =>
			({
				selectedAgentId: "codex",
				agentAutonomousModeEnabled: true,
			}) as never,
		setActiveRuntimeConfig: () => {},
		getScopedTerminalManager: async () => terminalManager as never,
		getScopedClineTaskSessionService: async () => ({}) as never,
		resolveInteractiveShellCommand: () => ({ binary: "sh", args: [] }),
		runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", combinedOutput: "", durationMs: 0 }),
		broadcastRuntimeWorkspaceStateUpdated: mocks.broadcastRuntimeWorkspaceStateUpdated,
		getUpdateStatus: () => ({}) as never,
		runUpdateNow: async () => ({}) as never,
	});
}

describe("agent score recording for runtime task starts", () => {
	beforeEach(() => {
		mocks.events.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.broadcastRuntimeWorkspaceStateUpdated.mockReset().mockResolvedValue(undefined);
		mocks.resolveTaskCwd.mockReset().mockResolvedValue("/tmp/worktree");
		mocks.captureTaskTurnCheckpoint.mockReset().mockRejectedValue(new Error("skip checkpoint"));
		mocks.resolveAgentCommand.mockReset().mockReturnValue({ agentId: "codex", binary: "codex", args: [] });
	});

	it("records one assigned event for a codex card across repeated starts", async () => {
		setBoard("in_progress", { ...reviewCard, agentId: "codex" });
		const api = createRuntimeApi({
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => ({ taskId: "task-1" })),
		});
		const input = { taskId: "task-1", prompt: "work", baseRef: "main", agentId: "codex" as const };

		expect((await api.startTaskSession(scope, input)).ok).toBe(true);
		expect((await api.startTaskSession(scope, input)).ok).toBe(true);
		expect(mocks.events).toEqual([{ type: "assigned", agentId: "codex", taskId: "task-1" }]);
		expect(mocks.recordAgentScoreEvent).toHaveBeenCalledTimes(2);
	});

	it("does not record assignment when the card has no agentId", async () => {
		setBoard("in_progress", { ...reviewCard, agentId: undefined });
		const api = createRuntimeApi({
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => ({ taskId: "task-1" })),
		});

		await api.startTaskSession(scope, {
			taskId: "task-1",
			prompt: "work",
			baseRef: "main",
			agentId: "codex",
		});

		expect(mocks.recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(mocks.events).toEqual([]);
	});
});

describe("agent score recording for runtime review messages", () => {
	beforeEach(() => {
		mocks.events.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.broadcastRuntimeWorkspaceStateUpdated.mockReset().mockResolvedValue(undefined);
		mocks.sendPromptToSession.mockReset().mockResolvedValue({ ok: true });
	});

	function createMessageApi() {
		return createRuntimeApi({ writeInput: vi.fn() });
	}

	it("records one round-two fail across repeated sends", async () => {
		setBoard("review", reviewCard);
		const api = createMessageApi();
		await api.sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		await api.sendTaskMessage(scope, { taskId: "task-1", message: "fix it again" });

		expect(mocks.events).toEqual([{ type: "fail", agentId: "codex", taskId: "task-1", round: 2 }]);
		expect(mocks.broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
	});

	it.each([
		["in_progress", true],
		["review", false],
	] as const)("does not score a card in %s with review enabled=%s", async (columnId, reviewEnabled) => {
		setBoard(columnId, { ...reviewCard, agentReviewEnabled: reviewEnabled });
		await createMessageApi().sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		expect(mocks.recordAgentScoreEvent).not.toHaveBeenCalled();
	});

	it("does not score when the task session is not running", async () => {
		setBoard("review", reviewCard);
		mocks.sendPromptToSession.mockResolvedValue({ ok: false });
		const response = await createMessageApi().sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		expect(response.ok).toBe(false);
		expect(mocks.recordAgentScoreEvent).not.toHaveBeenCalled();
	});
});

describe("agent score recording for public review handoffs", () => {
	beforeEach(() => {
		mocks.events.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.notifyStateUpdated.mockReset().mockResolvedValue({ ok: true });
		mocks.handOffTask.mockReset().mockResolvedValue({
			ok: true,
			taskId: "task-1",
			fromAgentId: "codex",
			toAgentId: "opencode",
		});
		setBoard("review", reviewCard);
	});

	it("records the source agent and review round after a successful handoff", async () => {
		await createCaller().runtime.handOffTask({ taskId: "task-1", reason: "fix it" });

		expect(mocks.events).toEqual([{ type: "fail", agentId: "codex", taskId: "task-1", round: 2 }]);
		expect(mocks.notifyStateUpdated).toHaveBeenCalledWith(scope);
	});

	it("does not record a failed handoff", async () => {
		mocks.handOffTask.mockResolvedValue({ ok: false, error: "failed" });
		await createCaller().runtime.handOffTask({ taskId: "task-1", reason: "fix it" });
		expect(mocks.recordAgentScoreEvent).not.toHaveBeenCalled();
	});
});
