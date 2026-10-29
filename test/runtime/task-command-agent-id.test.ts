import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliMocks = vi.hoisted(() => ({
	client: {
		projects: { add: { mutate: vi.fn(async () => ({ ok: true, project: { id: "workspace-1" } })) } },
		runtime: { handOffTask: { mutate: vi.fn() } },
	},
	loadWorkspaceContext: vi.fn(async () => ({ repoPath: "/tmp/repo" })),
}));

vi.mock("@trpc/client", () => ({
	createTRPCProxyClient: vi.fn(() => cliMocks.client),
	httpBatchLink: vi.fn(),
}));
vi.mock("../../src/state/workspace-state", () => ({ loadWorkspaceContext: cliMocks.loadWorkspaceContext }));

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
