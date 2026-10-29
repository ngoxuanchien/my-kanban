import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliMocks = vi.hoisted(() => ({
	client: {
		projects: { add: { mutate: vi.fn(async () => ({ ok: true, project: { id: "workspace-1" } })) } },
		workspace: {
			notifyStateUpdated: { mutate: vi.fn(async () => ({ ok: true })) },
			getState: { query: vi.fn(async () => ({}) as never) },
		},
		runtime: { handOffTask: { mutate: vi.fn() } },
	},
	loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/tmp/repo" })),
	workspaceState: {
		board: { columns: ["backlog", "in_progress", "review", "trash"].map((id) => ({ id, title: id, cards: [] })) },
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
	},
}));

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

import { parseAgentId, registerTaskCommand } from "../../src/commands/task";

describe("task command --agent-id parsing", () => {
	it("accepts launch-supported agents and default", () => {
		expect(parseAgentId("opencode")).toBe("opencode");
		expect(parseAgentId("claude")).toBe("claude");
		expect(parseAgentId("default")).toBeNull();
		expect(parseAgentId(undefined)).toBeUndefined();
	});

	it("rejects known agents that cannot be launched", () => {
		expect(() => parseAgentId("gemini")).toThrow('Invalid agent ID "gemini": is not supported for task launch.');
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
		await program.parseAsync(["node", "kanban", "task", "list"]);
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
