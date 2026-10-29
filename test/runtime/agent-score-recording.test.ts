import { beforeEach, describe, expect, it, vi } from "vitest";

interface ScoreEvent {
	type: string;
	agentId: string;
	taskId: string;
	round?: number;
	detail?: string;
	commit?: string;
	toAgentId?: string;
}

interface HistoryEvent extends Omit<ScoreEvent, "taskId"> {
	type: string;
	toAgentId?: string;
	agentSession?: { agentId: string; id?: string; transcriptPath?: string };
}

const mocks = vi.hoisted(() => ({
	board: { columns: [] as Array<{ id: string; title: string; cards: unknown[] }> },
	loadWorkspaceBoardById: vi.fn(),
	events: [] as ScoreEvent[],
	historyEvents: [] as Array<HistoryEvent & { taskId: string }>,
	recordAgentScoreEvent: vi.fn(async (_workspaceId: string, event: ScoreEvent) => {
		if (event.type === "fail") {
			const existing = mocks.events.find(
				(e) =>
					e.type === "fail" && e.agentId === event.agentId && e.taskId === event.taskId && e.round === event.round,
			);
			if (existing) {
				if (!existing.detail && event.detail) {
					existing.detail = event.detail;
					return true;
				}
				return false;
			}
		} else {
			const eventKey = (candidate: ScoreEvent) =>
				`${candidate.type}:${candidate.agentId}:${candidate.taskId}:${candidate.round ?? ""}`;
			if (mocks.events.some((existing) => eventKey(existing) === eventKey(event))) {
				return false;
			}
		}
		mocks.events.push(event);
		return true;
	}),
	recordTaskHistoryEvent: vi.fn(async (_workspaceId: string, taskId: string, event: HistoryEvent) => {
		const existing =
			event.type === "fail"
				? mocks.historyEvents.find(
						(candidate) =>
							candidate.type === "fail" && candidate.taskId === taskId && candidate.round === event.round,
					)
				: undefined;
		if (existing) {
			if (!existing.detail && event.detail) {
				existing.detail = event.detail;
				return true;
			}
			return false;
		}
		mocks.historyEvents.push({ ...event, taskId });
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
vi.mock("../../src/state/task-history", () => ({
	recordTaskHistoryEvent: mocks.recordTaskHistoryEvent,
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

function createRuntimeApi(terminalManager: Record<string, unknown> = {}, selectedAgentId: string | null = "codex") {
	return createRuntimeApiImpl({
		getActiveWorkspaceId: () => scope.workspaceId,
		loadScopedRuntimeConfig: async () =>
			({
				selectedAgentId,
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
		mocks.historyEvents.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.recordTaskHistoryEvent.mockClear();
		mocks.broadcastRuntimeWorkspaceStateUpdated.mockReset().mockResolvedValue(undefined);
		mocks.resolveTaskCwd.mockReset().mockResolvedValue("/tmp/worktree");
		mocks.captureTaskTurnCheckpoint.mockReset().mockRejectedValue(new Error("skip checkpoint"));
		mocks.resolveAgentCommand.mockReset().mockReturnValue({ agentId: "codex", binary: "codex", args: [] });
	});

	it("records one assigned event for a codex card across repeated starts", async () => {
		setBoard("in_progress", { ...reviewCard, agentId: "codex" });
		const api = createRuntimeApi({
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => ({ taskId: "task-1", agentId: "codex" })),
		});
		const input = { taskId: "task-1", prompt: "work", baseRef: "main", agentId: "codex" as const };

		expect((await api.startTaskSession(scope, input)).ok).toBe(true);
		expect((await api.startTaskSession(scope, input)).ok).toBe(true);
		expect(mocks.events).toEqual([{ type: "assigned", agentId: "codex", taskId: "task-1" }]);
		expect(mocks.recordAgentScoreEvent).toHaveBeenCalledTimes(2);
		expect(mocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "started",
			agentId: "codex",
		});
	});

	it("records the launched session agent when the card has no override", async () => {
		setBoard("in_progress", { ...reviewCard, agentId: undefined });
		mocks.resolveAgentCommand.mockReturnValue({ agentId: "claude", binary: "claude", args: [] });
		const api = createRuntimeApi({
			getSummary: vi.fn(() => null),
			startTaskSession: vi.fn(async () => ({ taskId: "task-1", agentId: "claude" })),
		});

		await api.startTaskSession(scope, {
			taskId: "task-1",
			prompt: "work",
			baseRef: "main",
		});

		expect(mocks.events).toEqual([{ type: "assigned", agentId: "claude", taskId: "task-1" }]);
		expect(mocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "started",
			agentId: "claude",
		});
	});
});

describe("agent score recording for runtime review messages", () => {
	beforeEach(() => {
		mocks.events.splice(0);
		mocks.historyEvents.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.recordTaskHistoryEvent.mockClear();
		mocks.broadcastRuntimeWorkspaceStateUpdated.mockReset().mockResolvedValue(undefined);
		mocks.sendPromptToSession.mockReset().mockResolvedValue({ ok: true });
	});

	function createMessageApi(agentId?: string) {
		return createRuntimeApi({ writeInput: vi.fn(), getSummary: vi.fn(() => (agentId ? { agentId } : null)) });
	}

	it("records one round-two fail with message across repeated sends", async () => {
		setBoard("review", reviewCard);
		const api = createMessageApi();
		await api.sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		await api.sendTaskMessage(scope, { taskId: "task-1", message: "fix it again" });

		expect(mocks.events).toEqual([{ type: "fail", agentId: "codex", taskId: "task-1", round: 2 }]);
		expect(mocks.historyEvents).toEqual([
			{ type: "fail", agentId: "codex", round: 2, detail: "fix it", taskId: "task-1" },
		]);
		expect(mocks.broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalledTimes(1);
	});

	it("uses the running session agent when the review card has no override", async () => {
		setBoard("review", { ...reviewCard, agentId: undefined });
		await createMessageApi("claude").sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		expect(mocks.events).toEqual([{ type: "fail", agentId: "claude", taskId: "task-1", round: 2 }]);
		expect(mocks.historyEvents).toEqual([
			{ type: "fail", agentId: "claude", round: 2, detail: "fix it", taskId: "task-1" },
		]);
	});

	it("does not record a review failure without a card, session, or default agent", async () => {
		setBoard("review", { ...reviewCard, agentId: undefined });
		const api = createRuntimeApi({ writeInput: vi.fn() }, null);
		await api.sendTaskMessage(scope, { taskId: "task-1", message: "fix it" });
		expect(mocks.events).toEqual([]);
		expect(mocks.historyEvents).toEqual([]);
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
		mocks.historyEvents.splice(0);
		mocks.recordAgentScoreEvent.mockClear();
		mocks.recordTaskHistoryEvent.mockClear();
		mocks.notifyStateUpdated.mockReset().mockResolvedValue({ ok: true });
		mocks.handOffTask.mockReset().mockResolvedValue({
			ok: true,
			taskId: "task-1",
			fromAgentId: "codex",
			toAgentId: "opencode",
		});
		setBoard("review", reviewCard);
	});

	it("records fail with reason and handoff with toAgentId after a successful handoff", async () => {
		await createCaller().runtime.handOffTask({ taskId: "task-1", reason: "fix it" });

		expect(mocks.events).toEqual([{ type: "fail", agentId: "codex", taskId: "task-1", round: 2 }]);
		expect(mocks.historyEvents).toEqual([
			{ type: "fail", agentId: "codex", taskId: "task-1", round: 2, detail: "fix it" },
			{ type: "handoff", agentId: "codex", toAgentId: "opencode", taskId: "task-1", round: 2, detail: "fix it" },
		]);
		expect(mocks.notifyStateUpdated).toHaveBeenCalledWith(scope);
	});

	it("task handoff right after task review-failed in the same round keeps one fail with the reason", async () => {
		mocks.historyEvents.push({ type: "fail", agentId: "codex", taskId: "task-1", round: 2 });

		await createCaller().runtime.handOffTask({ taskId: "task-1", reason: "fix it" });

		const fails = mocks.historyEvents.filter((e) => e.type === "fail");
		expect(fails).toHaveLength(1);
		expect(fails[0]).toEqual({ type: "fail", agentId: "codex", taskId: "task-1", round: 2, detail: "fix it" });
		expect(mocks.historyEvents).toContainEqual({
			type: "handoff",
			agentId: "codex",
			toAgentId: "opencode",
			taskId: "task-1",
			round: 2,
			detail: "fix it",
		});
	});

	it("does not record a failed handoff", async () => {
		mocks.handOffTask.mockResolvedValue({ ok: false, error: "failed" });
		await createCaller().runtime.handOffTask({ taskId: "task-1", reason: "fix it" });
		expect(mocks.recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(mocks.recordTaskHistoryEvent).not.toHaveBeenCalled();
	});
});
