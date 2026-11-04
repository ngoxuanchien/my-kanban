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
			setTaskIssueSummary: { mutate: vi.fn(async (_input: { taskId: string; summary: string }) => ({ ok: true })) },
		},
		runtime: {
			getConfig: { query: vi.fn(async () => ({ selectedAgentId: "claude" })) },
			getAgentModelCatalogs: { query: vi.fn(async () => ({}) as never) },
			handOffTask: { mutate: vi.fn() },
			stopTaskSession: { mutate: vi.fn(async () => ({ ok: true })) },
			startTaskSession: { mutate: vi.fn(async () => ({ ok: true, summary: { taskId: "task-1" } })) },
		},
	},
	loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/tmp/repo", workspaceId: "workspace-1" })),
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
	loadTaskHistory: vi.fn(async () => []),
	formatRecentTaskComments: vi.fn(() => ""),
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
		const result = mutate(cliMocks.workspaceState) as {
			board: typeof cliMocks.workspaceState.board;
			sessions?: typeof cliMocks.workspaceState.sessions;
			value: unknown;
		};
		cliMocks.workspaceState.board = result.board;
		if (result.sessions) cliMocks.workspaceState.sessions = result.sessions;
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

describe("task create --summary", () => {
	let cardCountsAtSummary: number[] = [];
	const backlogIds = () =>
		((cliMocks.workspaceState.board.columns[0]?.cards ?? []) as Array<{ id: string }>).map((card) => card.id);

	beforeEach(() => {
		cliMocks.workspaceState.board.columns[0]?.cards.splice(0);
		cliMocks.client.workspace.getState.query.mockImplementation(async () => cliMocks.workspaceState as never);
		cardCountsAtSummary = [];
		cliMocks.client.workspace.setTaskIssueSummary.mutate.mockReset();
		cliMocks.client.workspace.setTaskIssueSummary.mutate.mockImplementation(async () => {
			cardCountsAtSummary.push(cliMocks.workspaceState.board.columns[0]?.cards.length ?? -1);
			return { ok: true };
		});
		process.exitCode = 0;
	});

	async function create(args: string[]): Promise<{ task: { id: string } }> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "create", "--prompt", "Ship it", ...args]);
		write.mockRestore();
		return JSON.parse(output) as { task: { id: string } };
	}

	it("passes summary before creating the task", async () => {
		const created = await create(["--summary", "  Adds a login page.  "]);

		expect(cliMocks.client.workspace.setTaskIssueSummary.mutate).toHaveBeenCalledWith({
			taskId: created.task.id,
			summary: "Adds a login page.",
		});
		expect(cardCountsAtSummary).toEqual([0]);
		expect(backlogIds()).toEqual([created.task.id]);
	});

	it("does not call setTaskIssueSummary without --summary", async () => {
		await create([]);
		expect(cliMocks.client.workspace.setTaskIssueSummary.mutate).not.toHaveBeenCalled();
	});

	it("does not send a whitespace-only summary", async () => {
		await create(["--summary", "   "]);
		expect(cliMocks.client.workspace.setTaskIssueSummary.mutate).not.toHaveBeenCalled();
	});

	it("warns and still creates the task when storing the summary fails", async () => {
		cliMocks.client.workspace.setTaskIssueSummary.mutate.mockRejectedValue(new Error("runtime down"));
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
		const created = await create(["--summary", "Adds a login page."]);
		const warnings = stderr.mock.calls.map((call) => String(call[0]));
		stderr.mockRestore();

		expect(warnings.join("")).toContain("could not store the issue summary: runtime down");
		expect(backlogIds()).toEqual([created.task.id]);
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

	it("task update --agent-id clears agentModel and effort, keeps difficulty", async () => {
		const card = {
			id: "task-3",
			title: "Task",
			prompt: "Ship it",
			agentId: "codex",
			difficulty: 4,
			agentModel: "gpt-6.1-sol",
			agentReasoningEffort: "high",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
		};
		const cards = () => cliMocks.workspaceState.board.columns[0]?.cards as unknown as Record<string, unknown>[];
		cards().push(card);
		await run(["update", "--task-id", "task-3", "--title", "Renamed"]);
		await run(["update", "--task-id", "task-3", "--agent-id", "codex"]);
		expect(cards().find((candidate) => candidate.id === "task-3")).toMatchObject({
			agentModel: "gpt-6.1-sol",
			agentReasoningEffort: "high",
		});

		await run(["update", "--task-id", "task-3", "--agent-id", "opencode"]);
		const changed = cards().find((candidate) => candidate.id === "task-3");
		expect(changed).toMatchObject({ agentId: "opencode", difficulty: 4 });
		expect(changed).not.toHaveProperty("agentModel");
		expect(changed).not.toHaveProperty("agentReasoningEffort");
	});
});

describe("task difficulty and agent model options", () => {
	const catalogs = {
		codex: {
			ok: true,
			models: [
				{
					id: "gpt-6-luna",
					description: "Fast and affordable model for easier tasks",
					efforts: ["low", "medium", "high", "xhigh", "max"],
				},
				{ id: "gpt-6.1-sol", efforts: ["medium", "high"] },
			],
		},
		opencode: { ok: true, models: [{ id: "opencode/big-pickle", efforts: [] }] },
		claude: { ok: true, models: [{ id: "haiku", efforts: [] }] },
	};
	const cards = () => cliMocks.workspaceState.board.columns[0]?.cards as unknown as Record<string, unknown>[];

	beforeEach(() => {
		cards().splice(0);
		cliMocks.client.runtime.getConfig.query.mockResolvedValue({
			selectedAgentId: "claude",
			claudeDefaultModel: "opus",
		} as never);
		cliMocks.client.runtime.getAgentModelCatalogs.query.mockReset();
		cliMocks.client.runtime.getAgentModelCatalogs.query.mockResolvedValue(catalogs as never);
		cliMocks.client.workspace.getState.query.mockImplementation(async () => cliMocks.workspaceState as never);
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
		process.exitCode = 0;
		return JSON.parse(output) as { ok: boolean; task?: Record<string, unknown>; error?: string };
	}
	const create = (...args: string[]) => run(["create", "--prompt", "Ship it", ...args]);
	function addCard(fields: Record<string, unknown>): void {
		cards().push({
			id: "task-1",
			title: "Task",
			prompt: "Ship it",
			baseRef: "main",
			startInPlanMode: false,
			createdAt: 1,
			updatedAt: 1,
			...fields,
		});
	}

	it("stores --difficulty on create and update", async () => {
		const created = await create("--difficulty", "3");
		expect(created.task?.difficulty).toBe(3);
		expect(cards()[0]?.difficulty).toBe(3);
		const updated = await run(["update", "--task-id", created.task?.id as string, "--difficulty", "5"]);
		expect(updated.task?.difficulty).toBe(5);
	});

	it.each(["0", "6", "x", "2.5", ""])("rejects --difficulty %j on create and update", async (value) => {
		expect(await create("--difficulty", value)).toMatchObject({
			ok: false,
			error: expect.stringContaining("--difficulty"),
		});
		expect(cards()).toHaveLength(0);
		addCard({ agentId: "codex" });
		expect(await run(["update", "--task-id", "task-1", "--difficulty", value])).toMatchObject({
			ok: false,
			error: expect.stringContaining("--difficulty"),
		});
		expect(cards()[0]).not.toHaveProperty("difficulty");
	});

	it("accepts a Codex model id and effort for codex and rejects the id for claude", async () => {
		const created = await create("--agent-id", "codex", "--model", "gpt-6.1-sol", "--reasoning-effort", "high");
		expect(created.task).toMatchObject({ agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" });
		expect(created.task).not.toHaveProperty("claudeModel");

		const claude = await create("--agent-id", "claude", "--model", "gpt-6.1-sol");
		expect(claude).toMatchObject({ ok: false, error: expect.stringContaining("Expected: haiku, sonnet, opus") });
	});

	it("stores an OpenCode model id and rejects agents without a model option", async () => {
		const created = await create("--agent-id", "opencode", "--model", "opencode/big-pickle");
		expect(created.task?.agentModel).toBe("opencode/big-pickle");
		const antigravity = await create("--agent-id", "antigravity", "--model", "x");
		expect(antigravity).toMatchObject({ ok: false, error: expect.stringContaining("--model") });
	});

	it("rejects a model the catalog does not list, and accepts any id when the catalog is unavailable", async () => {
		const unknown = await create("--agent-id", "codex", "--model", "gpt-unknown");
		expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("task models") });
		expect(cards()).toHaveLength(0);

		cliMocks.client.runtime.getAgentModelCatalogs.query.mockResolvedValue({
			...catalogs,
			codex: { ok: false, error: "codex not found" },
		} as never);
		expect((await create("--agent-id", "codex", "--model", "gpt-unknown")).task?.agentModel).toBe("gpt-unknown");

		cliMocks.client.runtime.getAgentModelCatalogs.query.mockRejectedValue(new Error("old runtime"));
		expect((await create("--agent-id", "codex", "--model", "gpt-other")).task?.agentModel).toBe("gpt-other");
	});

	it("rejects a Claude alias for codex even when the catalog is unavailable", async () => {
		cliMocks.client.runtime.getAgentModelCatalogs.query.mockRejectedValue(new Error("old runtime"));
		expect(await create("--agent-id", "codex", "--model", "haiku")).toMatchObject({
			ok: false,
			error: expect.stringContaining("--model"),
		});
	});

	it.each(["claude", "opencode", "antigravity"])("rejects --reasoning-effort for %s", async (agentId) => {
		expect(await create("--agent-id", agentId, "--reasoning-effort", "high")).toMatchObject({
			ok: false,
			error: expect.stringContaining("--reasoning-effort"),
		});
	});

	it("uses the selected agent when the card has no agent", async () => {
		cliMocks.client.runtime.getConfig.query.mockResolvedValue({ selectedAgentId: "codex" } as never);
		expect((await create("--model", "gpt-6-luna")).task?.agentModel).toBe("gpt-6-luna");
	});

	it("clears the model and the effort independently with default", async () => {
		addCard({ agentId: "codex", difficulty: 4, agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" });
		const noModel = await run(["update", "--task-id", "task-1", "--model", "default"]);
		expect(noModel.task).not.toHaveProperty("agentModel");
		expect(noModel.task).toMatchObject({ agentReasoningEffort: "high", difficulty: 4 });
		expect(cards()[0]).not.toHaveProperty("agentModel");

		const noEffort = await run(["update", "--task-id", "task-1", "--reasoning-effort", "default"]);
		expect(noEffort.task).not.toHaveProperty("agentReasoningEffort");
		expect(cards()[0]).not.toHaveProperty("agentReasoningEffort");
		expect(cliMocks.client.runtime.getAgentModelCatalogs.query).not.toHaveBeenCalled();
	});

	it("sets the new agent's model after an agent change clears the old one", async () => {
		addCard({ agentId: "codex", agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" });
		await run(["update", "--task-id", "task-1", "--agent-id", "opencode", "--model", "opencode/big-pickle"]);
		expect(cards()[0]).toMatchObject({ agentId: "opencode", agentModel: "opencode/big-pickle" });
		expect(cards()[0]).not.toHaveProperty("agentReasoningEffort");
	});

	it("keeps agent model fields when other fields are updated", async () => {
		addCard({ agentId: "codex", difficulty: 2, agentModel: "gpt-6-luna" });
		await run(["update", "--task-id", "task-1", "--title", "Renamed"]);
		expect(cards()[0]).toMatchObject({ title: "Renamed", difficulty: 2, agentModel: "gpt-6-luna" });
	});
});

describe("task models command", () => {
	const map = {
		codex: {
			1: { model: "gpt-6-luna", reasoningEffort: "low" },
			3: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
		},
		opencode: {},
		claude: { 5: { model: "opus" } },
	};

	beforeEach(() => {
		cliMocks.client.runtime.getConfig.query.mockResolvedValue({ difficultyModelMap: map } as never);
		cliMocks.client.runtime.getAgentModelCatalogs.query.mockResolvedValue({
			codex: {
				ok: true,
				models: [
					{
						id: "gpt-6-luna",
						description: "Fast and affordable model for easier tasks",
						efforts: ["low", "medium", "high", "xhigh", "max"],
					},
				],
			},
			opencode: { ok: false, error: "opencode models failed: ENOENT" },
			claude: { ok: true, models: [{ id: "haiku", efforts: [] }] },
		} as never);
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			agentScores: [
				{ agentId: "codex:gpt-6.1-sol", score: 2, passes: 3, fails: 1, tasks: 4 },
				{ agentId: "codex", score: 1, passes: 1, fails: 0, tasks: 1 },
				{ agentId: "sonnet", score: 0, passes: 2, fails: 2, tasks: 3 },
				{ agentId: "antigravity", score: 1, passes: 1, fails: 0, tasks: 1 },
			],
		} as never);
		process.exitCode = 0;
	});

	async function models(...args: string[]): Promise<string> {
		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write);
		const program = new Command();
		registerTaskCommand(program);
		await program.parseAsync(["node", "kanban", "task", "models", ...args]);
		write.mockRestore();
		return output;
	}

	it("prints table rows, catalog lines, and scores per agent", async () => {
		const output = await models();
		expect(output).toContain("    3 → gpt-6.1-sol/medium");
		expect(output).toContain("    2 → default");
		expect(output).toContain("    5 → opus");
		expect(output).toContain(
			"    gpt-6-luna — Fast and affordable model for easier tasks [low,medium,high,xhigh,max]",
		);
		expect(output).toContain("    haiku\n");
		expect(output).toContain("    codex:gpt-6.1-sol 3/1");
		expect(output).toContain("    default 1/0");
		expect(output).toContain("    sonnet 2/2");
		expect(output).not.toContain("antigravity");
	});

	it("reports an unavailable catalog", async () => {
		expect(await models()).toContain("    catalog unavailable: opencode models failed: ENOENT");
	});

	it("limits the output with --agent and rejects an unknown agent", async () => {
		const output = await models("--agent", "claude");
		expect(output.startsWith("claude\n")).toBe(true);
		expect(output).not.toContain("gpt-6-luna");

		const invalid = JSON.parse(await models("--agent", "cline"));
		expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('Invalid --agent "cline"') });
		process.exitCode = 0;
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

	it("saves the started session record, so the issue comment can read the launched model", async () => {
		const summary = { taskId: "task-1", agentId: "codex", agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" };
		cliMocks.client.runtime.startTaskSession.mutate.mockResolvedValue({ ok: true, summary } as never);
		await run(["start", "--task-id", "task-1", "--message", "Fix it"]);
		expect(cliMocks.workspaceState.sessions).toEqual({ "task-1": summary });
	});

	it("adds recent comments to the restart prompt", async () => {
		historyMocks.loadTaskHistory.mockResolvedValue([
			{ type: "comment", agentId: "codex", at: 1, detail: "keep the existing parser" },
		] as never);
		historyMocks.formatRecentTaskComments.mockReturnValue(
			"Notes from earlier agents:\n- codex, 1970-01-01T00:00:00.001Z: keep the existing parser",
		);
		const result = await run(["start", "--task-id", "task-1", "--message", "continue"]);
		expect(result.ok).toBe(true);
		expect(cliMocks.client.runtime.startTaskSession.mutate).toHaveBeenCalledWith(
			expect.objectContaining({ prompt: expect.stringContaining("Notes from earlier agents:\n- codex,") }),
		);
		historyMocks.loadTaskHistory.mockResolvedValue([]);
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

	it("scores a Codex review with the session launch model", async () => {
		cliMocks.client.workspace.getState.query.mockResolvedValue({
			repoPath: "/tmp/repo",
			board: {
				columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({
					id,
					title: id,
					cards: id === "review" ? [reviewCard] : [],
				})),
			},
			sessions: { "task-1": { agentId: "codex", agentModel: "gpt-6.1-sol" } },
		} as never);
		await execute(["review-failed", "--task-id", "task-1"]);
		expect(scoreMocks.recordAgentScoreEvent).toHaveBeenCalledWith("workspace-1", {
			type: "fail",
			agentId: "codex:gpt-6.1-sol",
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
		expect(completionMocks.completeTaskToDone).toHaveBeenCalledWith(expect.objectContaining({ reviewPassed: true }));

		scoreMocks.recordAgentScoreEvent.mockClear();
		completionMocks.completeTaskToDone.mockClear();
		await execute(["done", "--task-id", "task-1"]);
		expect(scoreMocks.recordAgentScoreEvent).not.toHaveBeenCalled();
		expect(completionMocks.completeTaskToDone).toHaveBeenCalledWith(
			expect.objectContaining({ reviewPassed: undefined }),
		);
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
	const originalHookTaskId = process.env.KANBAN_HOOK_TASK_ID;
	const originalHookWorkspaceId = process.env.KANBAN_HOOK_WORKSPACE_ID;

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

	beforeEach(() => {
		historyMocks.loadTaskHistory.mockResolvedValue([
			{ type: "comment", agentId: "codex", at: 100, detail: "first" },
			{ type: "comment", agentId: "opencode", at: 200, detail: "second" },
		] as never);
		historyMocks.recordTaskHistoryEvent.mockClear();
		delete process.env.KANBAN_HOOK_TASK_ID;
		delete process.env.KANBAN_HOOK_WORKSPACE_ID;
	});

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

	it("shows d<n> only on rows of tasks with a difficulty", async () => {
		const backlog = state.board.columns[0].cards[0] as Record<string, unknown>;
		backlog.difficulty = 3;
		const output = await execute(["list"]);
		const compact = JSON.parse(await execute(["list", "--json"]));
		delete backlog.difficulty;
		expect(output).toContain("backl  backlog      codex   -     h0  -        d3 Waiting task");
		expect(output).toContain("h2  running  Active task");
		expect(compact.tasks[0].difficulty).toBe(3);
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
			task: {
				id: "active-1",
				prompt: "Prompt",
				reviewRound: 2,
				handOffCount: 2,
				comments: [
					{ agentId: "codex", at: 100, body: "first" },
					{ agentId: "opencode", at: 200, body: "second" },
				],
			},
		});
		process.exitCode = 0;
		const missing = JSON.parse(await execute(["show", "--task-id", "missing"]));
		expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("Task not found: missing") });
		expect(process.exitCode).toBe(1);
		process.exitCode = 0;
	});

	it("records comments using --task-id or KANBAN_HOOK_TASK_ID", async () => {
		const explicit = JSON.parse(await execute(["comment", "--task-id", "active-1", "--message", "decision"]));
		expect(explicit).toEqual({ ok: true, taskId: "active-1" });
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenLastCalledWith("workspace-1", "active-1", {
			type: "comment",
			agentId: "claude",
			detail: "decision",
		});

		process.env.KANBAN_HOOK_TASK_ID = "active-1";
		process.env.KANBAN_HOOK_WORKSPACE_ID = "hook-workspace";
		const fromEnv = JSON.parse(await execute(["comment", "--message", "x".repeat(2_500)]));
		expect(fromEnv).toEqual({ ok: true, taskId: "active-1" });
		expect(historyMocks.recordTaskHistoryEvent).toHaveBeenLastCalledWith("hook-workspace", "active-1", {
			type: "comment",
			agentId: "claude",
			detail: "x".repeat(2_500),
		});
		if (originalHookTaskId === undefined) delete process.env.KANBAN_HOOK_TASK_ID;
		else process.env.KANBAN_HOOK_TASK_ID = originalHookTaskId;
		if (originalHookWorkspaceId === undefined) delete process.env.KANBAN_HOOK_WORKSPACE_ID;
		else process.env.KANBAN_HOOK_WORKSPACE_ID = originalHookWorkspaceId;
	});

	it("returns a JSON error when a task comment has no task ID", async () => {
		const result = JSON.parse(await execute(["comment", "--message", "note"]));
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--task-id or KANBAN_HOOK_TASK_ID") });
		process.exitCode = 0;
	});
});
