import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliMocks = vi.hoisted(() => ({
	client: {
		projects: { add: { mutate: vi.fn(async () => ({ ok: true, project: { id: "workspace-1" } })) } },
		workspace: {
			notifyStateUpdated: { mutate: vi.fn(async () => ({ ok: true })) },
			getState: { query: vi.fn(async () => ({}) as never) },
			deleteWorktree: { mutate: vi.fn(async () => ({ ok: true, removed: true })) },
			ensureWorktree: { mutate: vi.fn(async () => ({ ok: true })) },
		},
		runtime: {
			getConfig: { query: vi.fn(async () => ({ selectedAgentId: "claude" })) },
			handOffTask: { mutate: vi.fn() },
			stopTaskSession: { mutate: vi.fn(async () => ({ ok: true })) },
			startTaskSession: { mutate: vi.fn(async () => ({ ok: true, summary: { taskId: "task-1" } })) },
		},
	},
	loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/tmp/repo" })),
	workspaceState: {
		repoPath: "/tmp/repo",
		board: {
			columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({ id, title: id, cards: [] })),
			dependencies: [],
		},
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		sessions: {},
	},
}));
const scoreMocks = vi.hoisted(() => ({ recordAgentScoreEvent: vi.fn(async () => true) }));
const historyMocks = vi.hoisted(() => ({
	recordTaskHistoryEvent: vi.fn(async () => true),
	deleteTaskHistory: vi.fn(async () => undefined),
}));
const completionMocks = vi.hoisted(() => ({ completeTaskToDone: vi.fn() }));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: vi.fn(() => cliMocks.client),
	httpBatchLink: vi.fn(),
}));
vi.mock("../../src/state/workspace-state", () => ({
	getTaskWorktreesHomePath: vi.fn(() => "/tmp/worktrees"),
	loadWorkspaceContext: cliMocks.loadWorkspaceContext,
	mutateWorkspaceState: vi.fn(async (_path: string, mutate: (state: typeof cliMocks.workspaceState) => unknown) => {
		const result = mutate(cliMocks.workspaceState) as { board: typeof cliMocks.workspaceState.board; value: unknown };
		cliMocks.workspaceState.board = result.board;
		return { saved: true, value: result.value };
	}),
}));
vi.mock("../../src/state/agent-scores", () => ({ recordAgentScoreEvent: scoreMocks.recordAgentScoreEvent }));
vi.mock("../../src/state/task-history", () => historyMocks);
vi.mock("../../src/workspace/complete-task-to-done", () => ({
	columnCanHaveLiveTaskSession: (columnId: string) => columnId === "in_progress" || columnId === "review",
	completeTaskToDone: completionMocks.completeTaskToDone,
}));

import { buildRestartPrompt, parseAgentId, registerTaskCommand } from "../../src/commands/task";

describe("task command --agent-id parsing", () => {
	it("accepts launch-supported agents and default", () => {
		expect(parseAgentId("opencode")).toBe("opencode");
		expect(parseAgentId("claude")).toBe("claude");
		expect(parseAgentId("default")).toBeNull();
		expect(parseAgentId(undefined)).toBeUndefined();
	});

	it.each(["cline", "droid", "kiro"])("rejects disabled agent %s", (agentId) => {
		expect(() => parseAgentId(agentId)).toThrow("Expected one of: claude, codex, antigravity, opencode, default.");
	});

	it("rejects unknown agents", () => {
		expect(() => parseAgentId("nope")).toThrow('Invalid agent ID "nope": is not a known agent.');
	});
});

describe("task handoff command", () => {
	beforeEach(() => {
		cliMocks.client.runtime.handOffTask.mutate.mockReset();
		cliMocks.client.projects.add.mutate.mockClear();
		cliMocks.client.runtime.handOffTask.mutate.mockResolvedValue({
			ok: true,
			fromAgentId: "codex",
			toAgentId: "opencode",
		});
		process.exitCode = 0;
	});

	async function execute(): Promise<string> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "handoff", "--task-id", "task-1", "--message", "fix it"]);
		write.mockRestore();
		return output;
	}

	it("prints task and agent IDs on success", async () => {
		const output = await execute();

		expect(JSON.parse(output)).toEqual({
			ok: true,
			taskId: "task-1",
			fromAgentId: "codex",
			toAgentId: "opencode",
		});
		expect(process.exitCode).toBe(0);
		expect(cliMocks.client.runtime.handOffTask.mutate).toHaveBeenCalledWith({ taskId: "task-1", reason: "fix it" });
	});

	it.each(["Task not found", "Task has already been handed off"])(
		"prints a handoff error and sets a non-zero exit code: %s",
		async (error) => {
			cliMocks.client.runtime.handOffTask.mutate.mockResolvedValue({
				ok: false,
				error,
			});

			const output = await execute();

			expect(JSON.parse(output)).toMatchObject({
				ok: false,
				error: expect.stringContaining(error),
			});
			expect(process.exitCode).toBe(1);
		},
	);
});

describe("task create agent review default", () => {
	beforeEach(() => {
		cliMocks.workspaceState.board.columns[0]?.cards.splice(0);
		cliMocks.client.projects.add.mutate.mockClear();
	});

	async function create(args: string[]): Promise<{ task: { agentReviewEnabled: boolean } }> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "create", "--prompt", "Ship it", ...args]);
		write.mockRestore();
		return JSON.parse(output) as { task: { agentReviewEnabled: boolean } };
	}

	it("enables agent review by default and allows opting out", async () => {
		expect((await create([])).task.agentReviewEnabled).toBe(true);
		expect((await create(["--agent-review-enabled", "false"])).task.agentReviewEnabled).toBe(false);
	});
});

describe("task command Claude model option", () => {
	beforeEach(() => {
		cliMocks.workspaceState.board.columns[0]?.cards.splice(0);
		cliMocks.client.runtime.getConfig.query.mockResolvedValue({
			selectedAgentId: "claude",
			claudeDefaultModel: "opus",
		} as never);
		cliMocks.client.workspace.getState.query.mockImplementation(async () => cliMocks.workspaceState as never);
		process.exitCode = 0;
	});

	async function run(
		args: string[],
	): Promise<{ ok: boolean; task?: Record<string, unknown>; tasks?: Array<Record<string, unknown>>; error?: string }> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", ...args]);
		write.mockRestore();
		return JSON.parse(output) as {
			ok: boolean;
			task?: Record<string, unknown>;
			tasks?: Array<Record<string, unknown>>;
			error?: string;
		};
	}

	it("creates and lists a Claude task model", async () => {
		const created = await run(["create", "--prompt", "Ship it", "--agent-id", "claude", "--model", "sonnet"]);
		expect(created.task?.claudeModel).toBe("sonnet");
		const listed = await run(["list", "--full"]);
		expect(listed.tasks?.[0]?.claudeModel).toBe("sonnet");
	});

	it("accepts model with selected Claude agent and rejects other agents or aliases", async () => {
		const selectedAgent = await run(["create", "--prompt", "Ship it", "--model", "haiku"]);
		expect(selectedAgent.task?.claudeModel).toBe("haiku");
		const otherAgent = await run(["create", "--prompt", "Ship it", "--agent-id", "codex", "--model", "haiku"]);
		expect(otherAgent).toMatchObject({ ok: false, error: expect.stringContaining("--model") });
		const invalidModel = await run(["create", "--prompt", "Ship it", "--model", "gpt"]);
		expect(invalidModel).toMatchObject({ ok: false, error: expect.stringContaining("--model") });
	});

	it("clears the model on update and preserves it when changing agents", async () => {
		const card = {
			id: "task-1",
			title: "Task",
			prompt: "Ship it",
			claudeModel: "haiku",
			agentId: "claude",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
		};
		(cliMocks.workspaceState.board.columns[0]?.cards as unknown as Record<string, unknown>[]).push(card);
		const cleared = await run(["update", "--task-id", "task-1", "--model", "default"]);
		expect(cleared.task).not.toHaveProperty("claudeModel");
		(cliMocks.workspaceState.board.columns[0]?.cards as unknown as Record<string, unknown>[]).push({
			...card,
			id: "task-2",
		});
		const changedAgent = await run(["update", "--task-id", "task-2", "--agent-id", "codex"]);
		expect(changedAgent.task?.claudeModel).toBe("haiku");
	});
});

describe("task start from Review", () => {
	const taskCard = {
		id: "task-1",
		title: "Fix it",
		prompt: "Original task prompt",
		agentId: "codex",
		baseRef: "main",
		startInPlanMode: false,
		handOffCount: 2,
		reviewRound: 6,
		createdAt: 1,
		updatedAt: 1,
	};

	beforeEach(() => {
		for (const column of cliMocks.workspaceState.board.columns) column.cards.splice(0);
		cliMocks.workspaceState.board.columns[2].cards.push(taskCard as never);
		cliMocks.workspaceState.sessions = { "task-1": { state: "stopped" } } as never;
		cliMocks.client.workspace.getState.query.mockImplementation(async () => cliMocks.workspaceState as never);
		cliMocks.client.workspace.ensureWorktree.mutate.mockReset();
		cliMocks.client.workspace.ensureWorktree.mutate.mockResolvedValue({ ok: true });
		cliMocks.client.runtime.startTaskSession.mutate.mockReset();
		cliMocks.client.runtime.startTaskSession.mutate.mockResolvedValue({
			ok: true,
			summary: { taskId: "task-1" },
		} as never);
		process.exitCode = 0;
	});

	async function run(args: string[]): Promise<{ ok: boolean; task?: Record<string, unknown>; error?: string }> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", ...args]);
		write.mockRestore();
		return JSON.parse(output) as { ok: boolean; task?: Record<string, unknown>; error?: string };
	}

	it("builds the restart prompt from the original request and reviewer notes", () => {
		expect(
			buildRestartPrompt({
				originalPrompt: "Original task prompt",
				baseRef: "main",
				message: "Fix src/a.ts",
			}),
		).toBe(
			"Original task prompt\n\n---\n[Kanban restart] Earlier work on this task is already in this worktree (uncommitted changes and commits since main). Check it and continue from it; do not start over.\nReviewer notes:\nFix src/a.ts",
		);
	});

	it("restarts a stopped Review task with reviewer notes and preserves its handoff metadata", async () => {
		const result = await run(["start", "--task-id", "task-1", "--message", "Fix src/a.ts and rerun checks"]);

		expect(result.ok).toBe(true);
		expect(cliMocks.client.runtime.startTaskSession.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				agentId: "codex",
				baseRef: "main",
				prompt: buildRestartPrompt({
					originalPrompt: "Original task prompt",
					baseRef: "main",
					message: "Fix src/a.ts and rerun checks",
				}),
			}),
		);
		expect(cliMocks.workspaceState.board.columns[1]?.cards[0]).toMatchObject({
			id: "task-1",
			handOffCount: 2,
			reviewRound: 6,
			agentId: "codex",
		});
		expect(cliMocks.workspaceState.board.columns[2]?.cards).toHaveLength(0);
	});

	it("rejects a Review task with a running session without starting or moving it", async () => {
		cliMocks.workspaceState.sessions = { "task-1": { state: "running" } } as never;
		const result = await run(["start", "--task-id", "task-1"]);

		expect(result.error).toContain('Task "task-1" is in review with a running session; use task send instead.');
		expect(cliMocks.client.runtime.startTaskSession.mutate).not.toHaveBeenCalled();
		expect(cliMocks.workspaceState.board.columns[2]?.cards[0]).toMatchObject({ id: "task-1" });
		expect(cliMocks.workspaceState.board.columns[1]?.cards).toHaveLength(0);
	});

	it("starts a Backlog task with its original prompt when no message is given", async () => {
		cliMocks.workspaceState.board.columns[2]?.cards.splice(0);
		cliMocks.workspaceState.board.columns[0]?.cards.push(taskCard as never);
		cliMocks.workspaceState.sessions = {};
		await run(["start", "--task-id", "task-1"]);

		expect(cliMocks.client.runtime.startTaskSession.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: "Original task prompt" }),
		);
	});
});

describe("task review scoring commands", () => {
	const reviewCard = {
		id: "task-1",
		prompt: "Review",
		title: "Review",
		agentId: "codex",
		agentReviewEnabled: true,
		reviewRound: 2,
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1,
		updatedAt: 1,
	};

	beforeEach(() => {
		for (const column of cliMocks.workspaceState.board.columns) column.cards.splice(0);
		scoreMocks.recordAgentScoreEvent.mockReset();
		scoreMocks.recordAgentScoreEvent.mockResolvedValue(true);
		historyMocks.recordTaskHistoryEvent.mockClear();
		historyMocks.deleteTaskHistory.mockClear();
		completionMocks.completeTaskToDone.mockReset();
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
					id,
					title: id,
					cards: id === "review" ? [reviewCard] : [],
				})),
			},
			sessions: {},
		} as never);
		cliMocks.client.runtime.getConfig.query.mockResolvedValue({
			selectedAgentId: "claude",
			claudeDefaultModel: "opus",
		} as never);
		completionMocks.completeTaskToDone.mockResolvedValue({
			previousColumnId: "review",
			alreadyInTrash: false,
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeDeleted: true,
			task: reviewCard,
			state: {
				repoPath: "/tmp/repo",
				board: { columns: [] },
				git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
				sessions: {},
			},
		});
	});

	async function execute(args: string[]): Promise<string> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", ...args]);
		write.mockRestore();
		return output;
	}

	it("records review-failed with message when --message is provided", async () => {
		expect(
			JSON.parse(await execute(["review-failed", "--task-id", "task-1", "--message", "syntax error in file.ts"])),
		).toEqual({
			ok: true,
			taskId: "task-1",
			recorded: true,
		});
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "fail",
			agentId: "codex",
			taskId: "task-1",
			round: 2,
		});
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "fail",
			agentId: "codex",
			round: 2,
			detail: "syntax error in file.ts",
		});
	});

	it("uses the session agent when a review card has no override", async () => {
		cliMocks.workspaceState.board.columns[2].cards = [{ ...reviewCard, agentId: undefined }] as never;
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
					id,
					title: id,
					cards: id === "review" ? [{ ...reviewCard, agentId: undefined }] : [],
				})),
			},
			sessions: { "task-1": { agentId: "claude" } },
		} as never);
		await execute(["review-failed", "--task-id", "task-1"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "fail",
			agentId: "opus",
			taskId: "task-1",
			round: 2,
		});
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "fail",
			agentId: "claude",
			round: 2,
			detail: undefined,
			commit: undefined,
		});
	});

	it("records a passed review for the session agent when the card has no override", async () => {
		const card = { ...reviewCard, agentId: undefined };
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
					id,
					title: id,
					cards: id === "review" ? [card] : [],
				})),
			},
			sessions: { "task-1": { agentId: "claude" } },
		} as never);
		await execute(["done", "--task-id", "task-1", "--review-passed"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "pass",
			agentId: "opus",
			taskId: "task-1",
			round: 2,
		});
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "pass",
			agentId: "claude",
			round: 2,
			commit: undefined,
		});
	});

	it("scores a Claude review with the session launch model", async () => {
		const card = { ...reviewCard, agentId: "claude", claudeModel: "sonnet" };
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
					id,
					title: id,
					cards: id === "review" ? [card] : [],
				})),
			},
			sessions: { "task-1": { agentId: "claude", claudeModel: "haiku" } },
		} as never);
		await execute(["done", "--task-id", "task-1", "--review-passed"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "pass",
			agentId: "haiku",
			taskId: "task-1",
			round: 2,
		});
	});

	it("records review-failed with the card agent and round, then reports de-duplication", async () => {
		expect(JSON.parse(await execute(["review-failed", "--task-id", "task-1"]))).toEqual({
			ok: true,
			taskId: "task-1",
			recorded: true,
		});
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "fail",
			agentId: "codex",
			taskId: "task-1",
			round: 2,
		});

		scoreMocks.recordAgentScoreEvent.mockResolvedValue(false);
		expect(JSON.parse(await execute(["review-failed", "--task-id", "task-1"]))).toMatchObject({ recorded: false });
	});

	it("requires --task-id when --review-passed is used", async () => {
		const result = JSON.parse(await execute(["done", "--column", "review", "--review-passed"]));
		expect(result.error).toContain("--review-passed requires --task-id");
		expect(scoreMocks.recordAgentScoreEvent).not.toHaveBeenCalled();
	});

	it("records a pass with commit when task done includes --commit", async () => {
		await execute(["done", "--task-id", "task-1", "--review-passed", "--commit", "abc1234"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "pass",
			agentId: "codex",
			taskId: "task-1",
			round: 2,
		});
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenCalledWith("workspace-1", "task-1", {
			type: "pass",
			agentId: "codex",
			round: 2,
			commit: "abc1234",
		});
		expect(historyMocks.deleteTaskHistory).not.toHaveBeenCalled();
	});

	it("records a pass only when task done explicitly marks a passed review", async () => {
		await execute(["done", "--task-id", "task-1", "--review-passed"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "pass",
			agentId: "codex",
			taskId: "task-1",
			round: 2,
		});
		expect(completionMocks.completeTaskToDone).toHaveBeenCalledTimes(1);

		scoreMocks.recordAgentScoreEvent.mockClear();
		await execute(["done", "--task-id", "task-1"]);
		expect(scoreMocks.recordAgentScoreEvent).not.toHaveBeenCalled();
	});

	it("removes task history file when task is permanently deleted by task-id", async () => {
		cliMocks.workspaceState.board.columns[2].cards = [{ id: "task-1", prompt: "Review" }] as never;
		const output = await execute(["delete", "--task-id", "task-1"]);
		expect(JSON.parse(output)).toMatchObject({ ok: true, count: 1 });
		expect(historyMocks.deleteTaskHistory).toHaveBeenCalledWith("workspace-1", "task-1");
	});

	it("removes every deleted task's history file when task delete --column done is run", async () => {
		cliMocks.workspaceState.board.columns[3].cards = [
			{ id: "task-done-1", prompt: "Done 1" },
			{ id: "task-done-2", prompt: "Done 2" },
		] as never;
		historyMocks.deleteTaskHistory.mockClear();

		const output = await execute(["delete", "--column", "done"]);
		expect(JSON.parse(output)).toMatchObject({ ok: true, count: 2 });
		expect(historyMocks.deleteTaskHistory).toHaveBeenCalledWith("workspace-1", "task-done-1");
		expect(historyMocks.deleteTaskHistory).toHaveBeenCalledWith("workspace-1", "task-done-2");
	});
});

describe("task list handoff count", () => {
	it("reports current, legacy, and default handoff counts", async () => {
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: [
					{
						id: "backlog",
						title: "Backlog",
						cards: [
							{ id: "counted", prompt: "Counted", handOffCount: 2 },
							{ id: "legacy", prompt: "Legacy", handedOff: true },
							{ id: "plain", prompt: "Plain" },
						],
					},
					...[
						{ id: "in_progress", title: "In Progress", cards: [] },
						{ id: "review", title: "Review", cards: [] },
						{ id: "trash", title: "Trash", cards: [] },
					],
				],
				dependencies: [],
			},
			git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
			sessions: {},
		} as never);
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "list", "--full"]);
		write.mockRestore();

		expect(JSON.parse(output)).toHaveProperty("tasks");
		expect(
			JSON.parse(output).tasks.map((task: { id: string; handOffCount: number }) => [task.id, task.handOffCount]),
		).toEqual([
			["counted", 2],
			["legacy", 1],
			["plain", 0],
		]);
	});
});

describe("compact task list and task show", () => {
	const state = {
		repoPath: "/tmp/repo",
		board: {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "backlog-1",
							title: "Waiting task",
							prompt: "Prompt",
							agentId: "codex",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "active-1",
							title: "Active task",
							prompt: "Prompt",
							agentId: "claude",
							reviewRound: 2,
							handOffCount: 2,
							agentReviewEnabled: true,
							createdAt: 2,
							updatedAt: 2,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{
					id: "trash",
					title: "Done",
					cards: [1, 2, 3, 4].map((n) => ({
						id: `done-${n}`,
						title: `Done task ${n}`,
						prompt: `Prompt ${n}`,
						createdAt: n + 2,
						updatedAt: n + 2,
					})),
				},
			],
			dependencies: [{ id: "dependency-1", fromTaskId: "backlog-1", toTaskId: "active-1", createdAt: 1 }],
		},
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		sessions: { "active-1": { state: "running", agentId: "claude" } },
	};

	async function execute(args: string[]): Promise<string> {
		cliMocks.client.workspace.getState.query.mockResolvedValue(state as never);
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", ...args]);
		write.mockRestore();
		return output;
	}

	it("prints aligned compact rows, trims Done, and includes dependency and newest-task lines", async () => {
		const output = await execute(["list"]);
		expect(output).toContain("backl  backlog      codex   -     h0  -        Waiting task");
		expect(output).toContain("activ  in_progress  claude  r2/9  h2  running  Active task");
		expect(output).toContain("(1 more done not shown; pass --column done or --all)");
		expect(output).toContain("links: backlog-1 waits on active-1 (dep dependency-1)");
		expect(output).toContain("last created: done-4 (-)");
		expect(output).not.toContain("Done task 4");
	});

	it.each([["--all"], ["--column", "done"]])("shows every Done task with %s", async (...args) => {
		const output = await execute(["list", ...args]);
		expect(output.match(/Done task/g)).toHaveLength(4);
		expect(output).not.toContain("more done not shown");
	});

	it("prints the compact JSON shape and preserves the full JSON list on --full", async () => {
		const compact = JSON.parse(await execute(["list", "--json"]));
		expect(compact).toMatchObject({
			ok: true,
			doneHidden: 1,
			dependencies: [{ taskId: "backlog-1", linkedTaskId: "active-1", dependencyId: "dependency-1" }],
			lastCreated: { id: "done-4", agentId: null },
		});
		expect(compact.tasks[0]).toEqual({
			id: "backlog-1",
			column: "backlog",
			agentId: "codex",
			reviewRound: 0,
			handOffCount: 0,
			session: null,
			title: "Waiting task",
		});
		expect(compact.tasks.at(-1)).toMatchObject({ id: "done-3", column: "done" });
		const full = JSON.parse(await execute(["list", "--full"]));
		expect(full).toMatchObject({ ok: true, workspacePath: "/tmp/repo", count: 2 });
		expect(full.tasks[0]).toHaveProperty("prompt", "Prompt");
		expect(full.tasks[0]).toHaveProperty("worktreePath");
	});

	it("shows the full record and returns a JSON error for an unknown ID", async () => {
		const shown = JSON.parse(await execute(["show", "--task-id", "active-1"]));
		expect(shown).toMatchObject({
			ok: true,
			task: { id: "active-1", prompt: "Prompt", reviewRound: 2, handOffCount: 2 },
		});
		process.exitCode = 0;
		const missing = JSON.parse(await execute(["show", "--task-id", "missing"]));
		expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("Task not found: missing") });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});
});
