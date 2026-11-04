import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBoardCard } from "../../src/core/api-contract";

const mocks = vi.hoisted(() => ({
	client: {
		workspace: {
			notifyStateUpdated: { mutate: vi.fn(async () => ({ ok: true })) },
			getState: { query: vi.fn() },
			getGithubIssues: { query: vi.fn(async () => ({ enabled: false, issues: {}, reports: {} })) },
		},
	},
	loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/tmp/repo", workspaceId: "workspace-1" })),
	loadWorkspaceContextById: vi.fn(async () => ({ repoPath: "/tmp/repo", workspaceId: "hook-workspace" })),
	state: {
		repoPath: "/tmp/repo",
		board: {
			columns: [] as Array<{ id: string; title: string; cards: RuntimeBoardCard[] }>,
			dependencies: [] as never[],
		},
		git: { currentBranch: "main", defaultBranch: "main", branches: ["main"] },
		sessions: {},
	},
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: vi.fn(() => mocks.client),
	httpBatchLink: vi.fn(),
}));
vi.mock("../../src/state/workspace-state", () => ({
	getTaskWorktreesHomePath: vi.fn(() => "/tmp/worktrees"),
	loadWorkspaceContext: mocks.loadWorkspaceContext,
	loadWorkspaceContextById: mocks.loadWorkspaceContextById,
	mutateWorkspaceState: vi.fn(async (_path: string, mutate: (state: typeof mocks.state) => unknown) => {
		const result = mutate(mocks.state) as { board: typeof mocks.state.board; value: unknown };
		mocks.state.board = result.board;
		return { saved: true, value: result.value };
	}),
}));
vi.mock("../../src/state/task-history", () => ({
	recordTaskHistoryEvent: vi.fn(async () => true),
	loadTaskHistory: vi.fn(async () => []),
	formatRecentTaskComments: vi.fn(() => ""),
	deleteTaskHistory: vi.fn(async () => undefined),
}));

import { registerTaskCommand } from "../../src/commands/task";

function card(id: string): RuntimeBoardCard {
	return { id, title: `Title ${id}`, prompt: id, baseRef: "main", startInPlanMode: false, createdAt: 1, updatedAt: 1 };
}

async function run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
	let output = "";
	const write = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
		output += chunk.toString();
		return true;
	}) as typeof process.stdout.write);
	for (const [key, value] of Object.entries(extraEnv)) vi.stubEnv(key, value);
	const program = new Command();
	registerTaskCommand(program);
	try {
		await program.parseAsync(["node", "kanban", "task", ...args]);
	} finally {
		write.mockRestore();
	}
	return output;
}

const blockedCard = () => mocks.state.board.columns[1]?.cards[0];

describe("task report", () => {
	beforeEach(() => {
		mocks.state.board = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [] },
				{ id: "in_progress", title: "In Progress", cards: [card("task-1")] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};
		mocks.client.workspace.getState.query.mockImplementation(async () => mocks.state);
		mocks.loadWorkspaceContextById.mockClear();
		process.exitCode = 0;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		process.exitCode = 0;
	});

	it("sets blockedReport for KANBAN_HOOK_TASK_ID and trims the question", async () => {
		const result = JSON.parse(
			await run(["report", "--state", "blocked", "--question", "  Use A or B?  "], {
				KANBAN_HOOK_TASK_ID: "task-1",
				KANBAN_HOOK_WORKSPACE_ID: "hook-workspace",
			}),
		);
		expect(result).toMatchObject({ ok: true, taskId: "task-1", question: "Use A or B?" });
		expect(blockedCard()?.blockedReport).toEqual({ question: "Use A or B?", reportedAt: result.reportedAt });
		expect(mocks.loadWorkspaceContextById).toHaveBeenCalledWith("hook-workspace");
		expect(mocks.client.workspace.notifyStateUpdated.mutate).toHaveBeenCalled();
	});

	it("replaces the question and reportedAt on a second call", async () => {
		const args = ["report", "--state", "blocked", "--task-id", "task-1", "--question"];
		await run([...args, "First?"]);
		const first = blockedCard()?.blockedReport;
		vi.spyOn(Date, "now").mockReturnValue((first?.reportedAt ?? 0) + 1000);
		await run([...args, "Second?"]);
		vi.restoreAllMocks();
		expect(blockedCard()?.blockedReport).toEqual({
			question: "Second?",
			reportedAt: (first?.reportedAt ?? 0) + 1000,
		});
	});

	it.each([
		["a missing question", ["--state", "blocked"], "non-empty --question"],
		["an empty question", ["--state", "blocked", "--question", ""], "non-empty --question"],
		["a whitespace question", ["--state", "blocked", "--question", "   "], "non-empty --question"],
		["a question over 500 characters", ["--state", "blocked", "--question", "x".repeat(501)], "at most 500"],
		["another state", ["--state", "ready", "--question", "Q?"], 'Only "blocked"'],
	])("rejects %s", async (_name, flags, message) => {
		const result = JSON.parse(await run(["report", "--task-id", "task-1", ...flags]));
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining(message) });
		expect(blockedCard()).not.toHaveProperty("blockedReport");
		process.exitCode = 0;
	});

	it("accepts a question of exactly 500 characters", async () => {
		const result = JSON.parse(
			await run(["report", "--state", "blocked", "--task-id", "task-1", "--question", "x".repeat(500)]),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects an unknown task", async () => {
		const result = JSON.parse(
			await run(["report", "--state", "blocked", "--task-id", "missing", "--question", "Q?"]),
		);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Task not found: missing") });
		process.exitCode = 0;
	});

	it("needs a task id outside a task session", async () => {
		vi.stubEnv("KANBAN_HOOK_TASK_ID", "");
		const result = JSON.parse(await run(["report", "--state", "blocked", "--question", "Q?"]));
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("KANBAN_HOOK_TASK_ID") });
		process.exitCode = 0;
	});

	it("shows the question in task list and the report in task show", async () => {
		await run(["report", "--state", "blocked", "--task-id", "task-1", "--question", "Use A or B?"]);
		const list = await run(["list"]);
		expect(list).toContain("blocked: Use A or B?");
		const shown = JSON.parse(await run(["show", "--task-id", "task-1"]));
		expect(shown.task.blockedReport).toMatchObject({ question: "Use A or B?" });
	});
});
