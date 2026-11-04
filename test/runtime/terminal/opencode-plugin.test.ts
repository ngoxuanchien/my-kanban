import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";

const stdinEndMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() =>
	vi.fn((_command: string, callback: (error: Error | null) => void) => {
		callback(null);
		return { stdin: { end: stdinEndMock } };
	}),
);
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	exec: execMock,
}));

interface OpenCodeEvent {
	type: string;
	data: Record<string, unknown>;
}

interface KanbanOpenCodePlugin {
	id: string;
	setup: (ctx: unknown) => Promise<() => Promise<void>>;
}

const originalHome = process.env.HOME;
const originalTaskId = process.env.KANBAN_HOOK_TASK_ID;
let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-opencode-plugin-"));
	process.env.HOME = tempHome;
	process.env.KANBAN_HOOK_TASK_ID = "task-1";
	execMock.mockClear();
	stdinEndMock.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	process.env.HOME = originalHome;
	if (originalTaskId === undefined) {
		delete process.env.KANBAN_HOOK_TASK_ID;
	} else {
		process.env.KANBAN_HOOK_TASK_ID = originalTaskId;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

async function loadPlugin(): Promise<KanbanOpenCodePlugin> {
	await prepareAgentLaunch({
		taskId: "task-1",
		agentId: "opencode",
		binary: "opencode",
		args: [],
		cwd: "/tmp",
		prompt: "",
		workspaceId: "workspace-1",
	});
	const pluginPath = join(tempHome, ".cline", "kanban", "hooks", "opencode", "kanban", "index.js");
	// The plugin is a generated file on disk, so it can only be loaded at runtime.
	const module = (await import(pathToFileURL(pluginPath).href)) as { default: KanbanOpenCodePlugin };
	return module.default;
}

function recordedCalls(): Array<{ event: string; metadata: Record<string, unknown> }> {
	return execMock.mock.calls.map(([command]) => {
		const [, event] = /'--event' '([^']+)'/.exec(command) ?? [];
		const [, encoded] = /--metadata-base64 (\S+)$/.exec(command) ?? [];
		return {
			event: event ?? "",
			metadata: JSON.parse(Buffer.from(encoded ?? "", "base64").toString("utf8")) as Record<string, unknown>,
		};
	});
}

async function runEvents(events: OpenCodeEvent[]): Promise<ReturnType<typeof recordedCalls>> {
	const plugin = await loadPlugin();
	await plugin.setup({
		event: {
			subscribe: async function* () {
				yield* events;
			},
		},
	});
	await vi.advanceTimersByTimeAsync(1000);
	return recordedCalls();
}

const root = "ses_root";
const child = "ses_child";

describe("Kanban OpenCode v2 plugin", () => {
	it("moves to in progress on execution start and to review with the last reply on success", async () => {
		const calls = await runEvents([
			{ type: "session.execution.started", data: { sessionID: root } },
			{ type: "session.tool.input.started", data: { sessionID: root, id: "call_1", name: "write" } },
			{ type: "session.tool.called", data: { sessionID: root, id: "call_1", input: { path: "hi.txt" } } },
			{ type: "session.tool.success", data: { sessionID: root, id: "call_1" } },
			{ type: "session.text.ended", data: { sessionID: root, text: " done. " } },
			{ type: "session.execution.succeeded", data: { sessionID: root } },
		]);

		expect(calls).toEqual([
			{ event: "to_in_progress", metadata: { hook_event_name: "session.status" } },
			{
				event: "activity",
				metadata: { hook_event_name: "BeforeTool", tool_name: "write", tool_input: { path: "hi.txt" } },
			},
			{ event: "activity", metadata: { hook_event_name: "AfterTool", tool_name: "write" } },
			{ event: "to_review", metadata: { hook_event_name: "session.idle", last_assistant_message: "done." } },
		]);
		// \`kanban hooks ingest\` waits for stdin EOF, so every hook call must close it.
		expect(stdinEndMock).toHaveBeenCalledTimes(calls.length);
	});

	it("ignores subagent sessions that run inside the root execution", async () => {
		const calls = await runEvents([
			{ type: "session.execution.started", data: { sessionID: root } },
			{ type: "session.execution.started", data: { sessionID: child } },
			{ type: "session.text.ended", data: { sessionID: child, text: "child reply" } },
			{ type: "session.execution.succeeded", data: { sessionID: child } },
			{ type: "session.execution.failed", data: { sessionID: root } },
		]);

		expect(calls).toEqual([
			{ event: "to_in_progress", metadata: { hook_event_name: "session.status" } },
			{ event: "to_review", metadata: { hook_event_name: "session.error" } },
		]);
	});

	it("stays in progress for auto-approved permissions", async () => {
		const calls = await runEvents([
			{ type: "session.execution.started", data: { sessionID: root } },
			{ type: "permission.asked", data: { sessionID: root, id: "per_1" } },
			{ type: "permission.replied", data: { sessionID: root, requestID: "per_1" } },
		]);

		expect(calls.map((call) => call.event)).toEqual(["to_in_progress"]);
	});

	it("permission.asked then succeeded sends activity then review", async () => {
		const plugin = await loadPlugin();
		let reply = () => {};
		const replied = new Promise<void>((resolve) => {
			reply = resolve;
		});
		await plugin.setup({
			event: {
				subscribe: async function* () {
					yield { type: "session.execution.started", data: { sessionID: root } };
					yield { type: "permission.asked", data: { sessionID: root, id: "per_1" } };
					await replied;
					yield { type: "permission.replied", data: { sessionID: root, requestID: "per_1" } };
					yield { type: "session.execution.succeeded", data: { sessionID: root } };
				},
			},
		});
		await vi.advanceTimersByTimeAsync(499);
		expect(recordedCalls()).toEqual([{ event: "to_in_progress", metadata: { hook_event_name: "session.status" } }]);
		await vi.advanceTimersByTimeAsync(1);
		expect(recordedCalls().map((call) => call.event)).toEqual(["to_in_progress", "activity"]);
		reply();
		await vi.advanceTimersByTimeAsync(0);

		expect(recordedCalls()).toEqual([
			{ event: "to_in_progress", metadata: { hook_event_name: "session.status" } },
			{
				event: "activity",
				metadata: { hook_event_name: "PermissionRequest", notification_type: "permission.asked" },
			},
			{ event: "to_review", metadata: { hook_event_name: "session.idle" } },
		]);
	});

	it("does nothing outside a Kanban task", async () => {
		delete process.env.KANBAN_HOOK_TASK_ID;
		const calls = await runEvents([{ type: "session.execution.started", data: { sessionID: root } }]);

		expect(calls).toEqual([]);
	});
});
