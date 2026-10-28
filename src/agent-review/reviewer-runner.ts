// Runs one reviewer pass and reports how it ended. CLI reviewers run as an interactive PTY session in
// the workspace's TerminalSessionManager (the same machinery and browser terminal as task agents) under
// the "agent-review:<taskId>" key; Cline runs as an in-process SDK session. Either way the reviewer
// writes its result to `verdictPath`, and the caller parses it.
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core/api-contract";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { parseReviewerVerdict } from "./reviewer-output";
import { classifyTurnEnd } from "./task-session-signals";

export const VERDICT_POLL_INTERVAL_MS = 1000;
// After asking the PTY to stop, wait this long for it to exit before reporting the outcome anyway.
export const REVIEWER_EXIT_GRACE_MS = 5000;

export type ReviewerRunOutcome =
	/** `verdict` is the verdict file's content, or null when the reviewer did not write it. */
	| { kind: "completed"; verdict: string | null }
	| { kind: "timeout" }
	| { kind: "crashed"; error: string }
	| { kind: "cancelled" }
	| { kind: "unavailable"; reason: string };

export interface ReviewerRunHandle {
	done: Promise<ReviewerRunOutcome>;
	cancel(): void;
}

export interface ReviewerLaunch {
	binary: string;
	args: string[];
	env?: Record<string, string>;
}

// OpenCode has no read-only flag. This config is applied last, so its edit deny beats user/agent
// rules that --auto would otherwise approve; question is denied because nobody should need to answer it.
const OPENCODE_REVIEWER_CONFIG = JSON.stringify({
	permissions: [
		{ action: "edit", resource: "*", effect: "deny" },
		{ action: "question", resource: "*", effect: "deny" },
	],
});

export type ReviewerTerminalManager = Pick<TerminalSessionManager, "startTaskSession" | "stopTaskSession" | "attach">;

type ReviewerClineService = Pick<
	ClineTaskSessionService,
	"onSummary" | "startTaskSession" | "stopTaskSession" | "getSummary"
>;

export interface StartReviewerRunInput {
	agentId: RuntimeAgentId;
	workspaceId: string;
	cwd: string;
	prompt: string;
	/** File the prompt tells the reviewer to write its JSON result to. Must be outside the worktree. */
	verdictPath: string;
	timeoutMs: number;
	isAgentInstalled(agentId: RuntimeAgentId): boolean;
	terminalManager: ReviewerTerminalManager;
	clineService?: ReviewerClineService;
	/** Session key: "agent-review:<taskId>". Never the task's own id. */
	reviewKey: string;
	pollIntervalMs?: number;
}

/**
 * Launch command for an interactive reviewer session; the adapter adds the prompt, hooks and autonomous
 * flags. Null when the agent cannot run as a PTY reviewer.
 */
export function buildReviewerLaunch(agentId: RuntimeAgentId, verdictDir: string): ReviewerLaunch | null {
	const entry = getRuntimeAgentCatalogEntry(agentId);
	if (!entry || !isRuntimeAgentLaunchSupported(agentId)) {
		return null;
	}
	switch (agentId) {
		case "claude":
			// Single comma-joined values: these options are variadic and the adapter appends the prompt last.
			return {
				binary: entry.binary,
				args: [
					...entry.baseArgs,
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
					"--allowedTools",
					"Bash,Read,Grep,Glob",
					"--disallowedTools",
					"Edit,Write,NotebookEdit",
					"--add-dir",
					verdictDir,
				],
			};
		// Codex and OpenCode have no MCP-specific flag to disable every configured server.
		case "codex":
		case "droid":
		case "kiro":
			return { binary: entry.binary, args: [...entry.baseArgs] };
		case "opencode":
			return {
				binary: entry.binary,
				args: [...entry.baseArgs],
				env: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEWER_CONFIG },
			};
		default:
			return null;
	}
}

export async function readVerdictFile(verdictPath: string): Promise<string | null> {
	try {
		return await readFile(verdictPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function settledHandle(outcome: ReviewerRunOutcome): ReviewerRunHandle {
	return { done: Promise.resolve(outcome), cancel: () => {} };
}

export function startReviewerRun(input: StartReviewerRunInput): ReviewerRunHandle {
	if (!isRuntimeAgentLaunchSupported(input.agentId)) {
		return settledHandle({ kind: "unavailable", reason: `Agent "${input.agentId}" is not launch-supported.` });
	}
	if (!input.isAgentInstalled(input.agentId)) {
		return settledHandle({ kind: "unavailable", reason: `Agent "${input.agentId}" is not installed.` });
	}
	if (input.agentId === "cline") {
		if (!input.clineService) {
			return settledHandle({ kind: "unavailable", reason: "Cline session service is not available." });
		}
		return startClineReviewerRun(input.clineService, input);
	}
	const launch = buildReviewerLaunch(input.agentId, dirname(input.verdictPath));
	if (!launch) {
		return settledHandle({ kind: "unavailable", reason: `Agent "${input.agentId}" cannot run as a reviewer.` });
	}
	return startPtyReviewerRun(launch, input);
}

function startPtyReviewerRun(launch: ReviewerLaunch, input: StartReviewerRunInput): ReviewerRunHandle {
	const { terminalManager, reviewKey } = input;
	let resolveDone: (outcome: ReviewerRunOutcome) => void = () => {};
	const done = new Promise<ReviewerRunOutcome>((resolve) => {
		resolveDone = resolve;
	});
	let started = false;
	// True once there is no process left to wait for (it exited, or it never started).
	let gone = false;
	let outcome: ReviewerRunOutcome | null = null;
	let detach: (() => void) | null = null;
	let exitGraceTimer: ReturnType<typeof setTimeout> | null = null;

	const resolveWithOutcome = () => {
		if (exitGraceTimer) {
			clearTimeout(exitGraceTimer);
			exitGraceTimer = null;
		}
		detach?.();
		detach = null;
		if (outcome) {
			resolveDone(outcome);
		}
	};

	const stopAndWaitForExit = () => {
		terminalManager.stopTaskSession(reviewKey);
		exitGraceTimer = setTimeout(resolveWithOutcome, REVIEWER_EXIT_GRACE_MS);
	};

	// Records the outcome, ends the session, and resolves once the process is gone so the next run
	// under the same key never finds this one still alive. While the session is still starting, the
	// start callbacks below finish the job.
	const finish = (next: ReviewerRunOutcome) => {
		if (outcome) {
			return;
		}
		outcome = next;
		clearTimeout(timeoutTimer);
		clearInterval(pollTimer);
		if (gone) {
			resolveWithOutcome();
		} else if (started) {
			stopAndWaitForExit();
		}
	};

	const finishWithVerdict = async (exitCode: number | null) => {
		let verdict: string | null;
		try {
			verdict = await readVerdictFile(input.verdictPath);
		} catch (error) {
			finish({ kind: "crashed", error: `Could not read the verdict file: ${errorMessage(error)}` });
			return;
		}
		if (verdict === null && exitCode !== null && exitCode !== 0) {
			finish({ kind: "crashed", error: `Reviewer exited with code ${exitCode}.` });
			return;
		}
		finish({ kind: "completed", verdict });
	};

	const pollVerdict = async () => {
		if (outcome) {
			return;
		}
		// A file that does not parse yet may still be being written; the turn end or timeout decides then.
		const verdict = await readVerdictFile(input.verdictPath).catch(() => null);
		if (verdict !== null && parseReviewerVerdict(verdict).ok) {
			finish({ kind: "completed", verdict });
		}
	};

	const timeoutTimer = setTimeout(() => finish({ kind: "timeout" }), input.timeoutMs);
	const pollTimer = setInterval(() => void pollVerdict(), input.pollIntervalMs ?? VERDICT_POLL_INTERVAL_MS);

	void terminalManager
		.startTaskSession({
			taskId: reviewKey,
			agentId: input.agentId,
			binary: launch.binary,
			args: launch.args,
			// Nobody is there to approve tool calls; read-only is enforced by the launch args and the snapshot check.
			autonomousModeEnabled: true,
			cwd: input.cwd,
			prompt: input.prompt,
			env: launch.env,
			workspaceId: input.workspaceId,
			disableAutoRestart: true,
			// The reviewer tab must still show the reviewer's last screen after the review is done.
			suppressAlternateScreen: true,
		})
		.then(() => {
			started = true;
			detach = terminalManager.attach(reviewKey, {
				onState: (summary: RuntimeTaskSessionSummary) => {
					// A permission prompt ("needs_user") stays open: the user can answer it in the live terminal.
					if (!outcome && classifyTurnEnd(summary) === "turn_end") {
						void finishWithVerdict(null);
					}
				},
				onExit: (exitCode) => {
					gone = true;
					if (outcome) {
						resolveWithOutcome();
					} else {
						void finishWithVerdict(exitCode);
					}
				},
			});
			if (outcome) {
				// Cancelled or timed out while the session was starting.
				stopAndWaitForExit();
			}
		})
		.catch((error: unknown) => {
			gone = true;
			if (outcome) {
				resolveWithOutcome();
			} else {
				finish({ kind: "crashed", error: errorMessage(error) });
			}
		});

	return { done, cancel: () => finish({ kind: "cancelled" }) };
}

function startClineReviewerRun(service: ReviewerClineService, input: StartReviewerRunInput): ReviewerRunHandle {
	const key = input.reviewKey;
	let resolveDone: (outcome: ReviewerRunOutcome) => void = () => {};
	const done = new Promise<ReviewerRunOutcome>((resolve) => {
		resolveDone = resolve;
	});
	let started = false;
	let settled = false;

	const stopSession = () => {
		void service.stopTaskSession(key).catch(() => null);
	};

	const settle = (outcome: ReviewerRunOutcome) => {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		if (started) {
			stopSession();
		}
		resolveDone(outcome);
	};

	const handleSummary = (summary: RuntimeTaskSessionSummary | null) => {
		if (!started || !summary || summary.taskId !== key || summary.state === "running") {
			return;
		}
		if (summary.state === "failed") {
			settle({ kind: "crashed", error: summary.warningMessage ?? "Cline reviewer session failed." });
			return;
		}
		void readVerdictFile(input.verdictPath).then(
			(verdict) => settle({ kind: "completed", verdict }),
			(error: unknown) =>
				settle({ kind: "crashed", error: `Could not read the verdict file: ${errorMessage(error)}` }),
		);
	};

	const unsubscribe = service.onSummary(handleSummary);
	const timer = setTimeout(() => settle({ kind: "timeout" }), input.timeoutMs);

	service
		.startTaskSession({ taskId: key, cwd: input.cwd, prompt: input.prompt, mode: "act" })
		.then((summary) => {
			started = true;
			if (settled) {
				// Cancelled or timed out while the session was starting.
				stopSession();
				return;
			}
			handleSummary(service.getSummary(key) ?? summary);
		})
		.catch((error: unknown) => {
			settle({ kind: "crashed", error: errorMessage(error) });
		});

	return { done, cancel: () => settle({ kind: "cancelled" }) };
}
