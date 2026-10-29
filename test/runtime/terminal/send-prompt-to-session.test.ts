import { describe, expect, it, vi } from "vitest";

import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { sendPromptToSession } from "../../../src/terminal/send-prompt-to-session";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(): RuntimeTaskSessionSummary {
	return {
		taskId: "session-1",
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
			sessionId: "session-1",
			prompt: "fix it",
			terminalManager: terminalManager as unknown as TerminalSessionManager,
			clineService: clineService as unknown as ClineTaskSessionService,
			sleep: vi.fn(async () => {}),
		},
	};
}

describe("sendPromptToSession", () => {
	it("pastes the prompt into the PTY, waits, then submits", async () => {
		const deps = createDeps();

		const result = await sendPromptToSession({ ...deps.input, agentId: "claude" });

		expect(result).toEqual({ ok: true });
		expect(deps.writes).toEqual(["\x1b[200~fix it\x1b[201~", "\r"]);
		expect(deps.input.sleep).toHaveBeenCalledWith(200);
		expect(deps.clineService.sendTaskSessionInput).not.toHaveBeenCalled();
	});

	it("sends Antigravity prompts through the PTY as a bracketed paste before Enter", async () => {
		const deps = createDeps();

		const result = await sendPromptToSession({ ...deps.input, agentId: "antigravity" });

		expect(result).toEqual({ ok: true });
		expect(deps.writes).toEqual(["\x1b[200~fix it\x1b[201~", "\r"]);
		expect(deps.input.sleep).toHaveBeenCalledWith(200);
		expect(deps.clineService.sendTaskSessionInput).not.toHaveBeenCalled();
	});

	it("reports a dead PTY session as session_not_running", async () => {
		const deps = createDeps();
		deps.terminalManager.writeInput.mockReturnValue(null);

		const result = await sendPromptToSession({ ...deps.input, agentId: "codex" });

		expect(result).toEqual({ ok: false, reason: "session_not_running" });
		expect(deps.terminalManager.writeInput).toHaveBeenCalledTimes(1);
	});

	it("sends Cline prompts in act mode", async () => {
		const deps = createDeps();

		const result = await sendPromptToSession({ ...deps.input, agentId: "cline" });

		expect(result).toEqual({ ok: true });
		expect(deps.clineService.sendTaskSessionInput).toHaveBeenCalledWith("session-1", "fix it", "act");
		expect(deps.terminalManager.writeInput).not.toHaveBeenCalled();
	});
});
