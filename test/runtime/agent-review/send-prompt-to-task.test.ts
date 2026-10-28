import { describe, expect, it, vi } from "vitest";

import { sendPromptToTask } from "../../../src/agent-review/send-prompt-to-task";
import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function createDeps() {
	const writes: string[] = [];
	const terminalManager = {
		writeInput: vi.fn((_taskId: string, data: Buffer): RuntimeTaskSessionSummary | null => {
			writes.push(data.toString("utf8"));
			return createSummary();
		}),
	};
	const clineService = {
		sendTaskSessionInput: vi.fn(async (): Promise<RuntimeTaskSessionSummary | null> => createSummary()),
		rebindPersistedTaskSession: vi.fn(async (): Promise<RuntimeTaskSessionSummary | null> => createSummary()),
	};
	return {
		writes,
		terminalManager,
		clineService,
		input: {
			taskId: "task-1",
			prompt: "fix",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			sleep: vi.fn(async () => {}),
		},
	};
}

describe("sendPromptToTask", () => {
	it("pastes the prompt into the PTY, waits, then submits", async () => {
		const deps = createDeps();
		const result = await sendPromptToTask({ ...deps.input, agentId: "claude" });
		expect(result).toEqual({ ok: true });
		expect(deps.writes).toEqual(["\x1b[200~fix\x1b[201~", "\r"]);
		expect(deps.input.sleep).toHaveBeenCalledWith(200);
		expect(deps.clineService.sendTaskSessionInput).not.toHaveBeenCalled();
	});

	it("reports a dead PTY session as task_agent_not_running", async () => {
		const deps = createDeps();
		deps.terminalManager.writeInput.mockReturnValue(null);
		const result = await sendPromptToTask({ ...deps.input, agentId: "codex" });
		expect(result).toEqual({ ok: false, reason: "task_agent_not_running" });
		expect(deps.terminalManager.writeInput).toHaveBeenCalledTimes(1);
	});

	it("sends Cline prompts in act mode", async () => {
		const deps = createDeps();
		const result = await sendPromptToTask({ ...deps.input, agentId: "cline" });
		expect(result).toEqual({ ok: true });
		expect(deps.clineService.sendTaskSessionInput).toHaveBeenCalledWith("task-1", "fix", "act");
		expect(deps.terminalManager.writeInput).not.toHaveBeenCalled();
	});

	it("rebinds a persisted Cline session once, then succeeds", async () => {
		const deps = createDeps();
		deps.clineService.sendTaskSessionInput.mockResolvedValueOnce(null);
		const result = await sendPromptToTask({ ...deps.input, agentId: "cline" });
		expect(result).toEqual({ ok: true });
		expect(deps.clineService.rebindPersistedTaskSession).toHaveBeenCalledTimes(1);
		expect(deps.clineService.sendTaskSessionInput).toHaveBeenCalledTimes(2);
	});

	it("reports a Cline session that cannot be rebound as task_agent_not_running", async () => {
		const deps = createDeps();
		deps.clineService.sendTaskSessionInput.mockResolvedValue(null);
		deps.clineService.rebindPersistedTaskSession.mockResolvedValue(null);
		const result = await sendPromptToTask({ ...deps.input, agentId: "cline" });
		expect(result).toEqual({ ok: false, reason: "task_agent_not_running" });
		expect(deps.clineService.sendTaskSessionInput).toHaveBeenCalledTimes(1);
	});
});
