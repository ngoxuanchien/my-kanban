import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeAgentId } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

const PTY_SUBMIT_DELAY_MS = 200;

export type SendPromptResult = { ok: true } | { ok: false; reason: "task_agent_not_running" };

const NOT_RUNNING: SendPromptResult = { ok: false, reason: "task_agent_not_running" };

export async function sendPromptToTask(input: {
	taskId: string;
	prompt: string;
	agentId: RuntimeAgentId | null;
	terminalManager: TerminalSessionManager;
	clineService: ClineTaskSessionService;
	sleep?: (ms: number) => Promise<void>;
}): Promise<SendPromptResult> {
	const { taskId, prompt, terminalManager, clineService } = input;
	if (input.agentId === "cline") {
		if (await clineService.sendTaskSessionInput(taskId, prompt, "act")) {
			return { ok: true };
		}
		if (!(await clineService.rebindPersistedTaskSession(taskId))) {
			return NOT_RUNNING;
		}
		return (await clineService.sendTaskSessionInput(taskId, prompt, "act")) ? { ok: true } : NOT_RUNNING;
	}

	// Bracketed paste keeps a multi-line prompt as one input, then Enter submits it (same as the browser path).
	if (!terminalManager.writeInput(taskId, Buffer.from(`\x1b[200~${prompt}\x1b[201~`, "utf8"))) {
		return NOT_RUNNING;
	}
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	await sleep(PTY_SUBMIT_DELAY_MS);
	return terminalManager.writeInput(taskId, Buffer.from("\r", "utf8")) ? { ok: true } : NOT_RUNNING;
}
