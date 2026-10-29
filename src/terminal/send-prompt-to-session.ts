import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeAgentId } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";

const PTY_SUBMIT_DELAY_MS = 200;

export type SendPromptToSessionResult = { ok: true } | { ok: false; reason: "session_not_running" };

const NOT_RUNNING: SendPromptToSessionResult = { ok: false, reason: "session_not_running" };

/**
 * Writes a prompt into a live task or home-agent session.
 *
 * OpenCode v2 caveat: a prompt can land in the terminal without starting a turn
 * (see commit 33669791). Callers should treat `{ ok: true }` as "delivered to
 * the session input" rather than "a turn has started".
 */
export async function sendPromptToSession(input: {
	sessionId: string;
	prompt: string;
	agentId: RuntimeAgentId | null;
	terminalManager: TerminalSessionManager;
	clineService: ClineTaskSessionService;
	sleep?: (ms: number) => Promise<void>;
}): Promise<SendPromptToSessionResult> {
	const { sessionId, prompt, terminalManager, clineService } = input;
	if (input.agentId === "cline") {
		if (await clineService.sendTaskSessionInput(sessionId, prompt, "act")) {
			return { ok: true };
		}
		if (!(await clineService.rebindPersistedTaskSession(sessionId))) {
			return NOT_RUNNING;
		}
		return (await clineService.sendTaskSessionInput(sessionId, prompt, "act")) ? { ok: true } : NOT_RUNNING;
	}

	// Bracketed paste keeps a multi-line prompt as one input, then Enter submits it (same as the browser path).
	if (!terminalManager.writeInput(sessionId, Buffer.from(`\x1b[200~${prompt}\x1b[201~`, "utf8"))) {
		return NOT_RUNNING;
	}
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	await sleep(PTY_SUBMIT_DELAY_MS);
	return terminalManager.writeInput(sessionId, Buffer.from("\r", "utf8")) ? { ok: true } : NOT_RUNNING;
}
