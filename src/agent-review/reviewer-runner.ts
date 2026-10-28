// Runs one reviewer pass as a one-shot agent process (or a Cline SDK session)
// and reports how it ended. The caller parses the output.
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import treeKill from "tree-kill";

import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import { getRuntimeAgentCatalogEntry, isRuntimeAgentLaunchSupported } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeTaskSessionSummary } from "../core/api-contract";
import { createClaudeStreamParser } from "./claude-stream-json";

const MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;

export type ReviewerRunOutcome =
	| { kind: "completed"; output: string }
	| { kind: "timeout" }
	| { kind: "crashed"; error: string }
	| { kind: "cancelled" }
	| { kind: "unavailable"; reason: string };

export interface ReviewerRunHandle {
	done: Promise<ReviewerRunOutcome>;
	cancel(): void;
}

export interface ReviewerCommand {
	binary: string;
	args: string[];
	promptVia: "stdin" | "arg";
	env?: Record<string, string>;
	/** stdout is Claude stream-json: shown as readable lines, verdict taken from the result event. */
	stdoutFormat?: "claude-stream-json";
}

// OpenCode run has no read-only flag. This config is applied last, so its edit deny beats user/agent
// rules that --auto would otherwise approve; question is denied because nobody can answer it.
const OPENCODE_REVIEWER_CONFIG = JSON.stringify({
	permissions: [
		{ action: "edit", resource: "*", effect: "deny" },
		{ action: "question", resource: "*", effect: "deny" },
	],
});

type SpawnReviewer = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

type ReviewerClineService = Pick<
	ClineTaskSessionService,
	"onSummary" | "startTaskSession" | "stopTaskSession" | "getSummary"
>;

export interface StartReviewerRunInput {
	agentId: RuntimeAgentId;
	cwd: string;
	prompt: string;
	timeoutMs: number;
	isAgentInstalled(agentId: RuntimeAgentId): boolean;
	clineService?: ReviewerClineService;
	/** Session key for Cline runs: "agent-review:<taskId>". Never the task's own id. */
	reviewKey: string;
	/** Receives readable stdout/stderr as it arrives (process runs only). */
	onOutput?: (chunk: string) => void;
	spawnImpl?: SpawnReviewer;
}

/** Returns null when the agent has no confirmed non-interactive mode. */
export function buildReviewerCommand(agentId: RuntimeAgentId): ReviewerCommand | null {
	const entry = getRuntimeAgentCatalogEntry(agentId);
	if (!entry || !isRuntimeAgentLaunchSupported(agentId)) {
		return null;
	}
	switch (agentId) {
		case "claude":
			return {
				binary: entry.binary,
				args: [
					"-p",
					"--strict-mcp-config",
					"--mcp-config",
					'{"mcpServers":{}}',
					"--output-format",
					"stream-json",
					"--verbose",
					"--disallowedTools",
					"Edit",
					"Write",
					"NotebookEdit",
					"--allowedTools",
					"Bash",
					"Read",
					"Grep",
					"Glob",
				],
				promptVia: "stdin",
				stdoutFormat: "claude-stream-json",
			};
		// Codex and OpenCode have no MCP-specific flag to disable every configured server.
		// The others print readable progress as they go, so their raw output is shown.
		case "codex":
			return { binary: entry.binary, args: ["exec", "-", ...entry.autonomousArgs], promptVia: "stdin" };
		case "droid":
			return { binary: entry.binary, args: ["exec", ...entry.autonomousArgs], promptVia: "arg" };
		case "kiro":
			return { binary: entry.binary, args: ["chat", "--no-interactive", "--trust-all-tools"], promptVia: "arg" };
		case "opencode":
			// --standalone: private server per run, so the tree kill also stops it (see task launches).
			return {
				binary: entry.binary,
				args: ["run", "--standalone", ...entry.autonomousArgs],
				promptVia: "arg",
				env: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEWER_CONFIG },
			};
		default:
			return null;
	}
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
	const command = buildReviewerCommand(input.agentId);
	if (!command) {
		return settledHandle({
			kind: "unavailable",
			reason: `Agent "${input.agentId}" has no non-interactive mode for reviews.`,
		});
	}
	return startProcessReviewerRun(command, input);
}

function startProcessReviewerRun(command: ReviewerCommand, input: StartReviewerRunInput): ReviewerRunHandle {
	let resolveDone: (outcome: ReviewerRunOutcome) => void = () => {};
	const done = new Promise<ReviewerRunOutcome>((resolve) => {
		resolveDone = resolve;
	});
	let stopReason: "timeout" | "cancelled" | null = null;
	let settled = false;
	let output = "";

	const settle = (outcome: ReviewerRunOutcome) => {
		if (settled) {
			return;
		}
		settled = true;
		clearTimeout(timer);
		resolveDone(outcome);
	};

	const args = command.promptVia === "arg" ? [...command.args, input.prompt] : command.args;
	const child = (input.spawnImpl ?? spawn)(command.binary, args, {
		cwd: input.cwd,
		// OpenCode resolves its project directory from PWD, not the process cwd.
		env: { ...process.env, ...command.env, PWD: input.cwd },
		detached: true,
		stdio: [command.promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"],
	});

	const streamParser = command.stdoutFormat === "claude-stream-json" ? createClaudeStreamParser() : null;
	const emit = (text: string) => {
		if (text) {
			input.onOutput?.(text);
		}
	};
	const capture = (text: string) => {
		emit(text);
		output += text;
		if (output.length > MAX_CAPTURED_OUTPUT_CHARS) {
			output = output.slice(-MAX_CAPTURED_OUTPUT_CHARS);
		}
	};
	// setEncoding keeps a multi-byte character split across chunks intact.
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (text: string) => {
		if (streamParser) {
			emit(streamParser.push(text));
		} else {
			capture(text);
		}
	});
	child.stderr?.on("data", capture);

	if (command.promptVia === "stdin" && child.stdin) {
		// The agent may exit before reading stdin; that shows up in the exit code, not here.
		child.stdin.on("error", () => {});
		child.stdin.end(input.prompt);
	}

	const killTree = (reason: "timeout" | "cancelled") => {
		if (settled || stopReason) {
			return;
		}
		stopReason = reason;
		if (typeof child.pid === "number") {
			// detached: the reviewer leads its own process group, which still holds children it orphaned.
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			treeKill(child.pid, "SIGKILL", () => {});
		}
		// Do not wait for "close": a process that escaped the group can keep the output pipes open forever.
		settle({ kind: reason });
	};

	const timer = setTimeout(() => killTree("timeout"), input.timeoutMs);

	child.on("error", (error) => {
		settle(stopReason ? { kind: stopReason } : { kind: "crashed", error: error.message });
	});
	child.on("close", (code, signal) => {
		if (stopReason) {
			settle({ kind: stopReason });
			return;
		}
		let finalOutput = output;
		if (streamParser) {
			const finished = streamParser.finish();
			emit(finished.display);
			finalOutput = finished.output;
		}
		if (code === 0 || finalOutput.trim().length > 0) {
			settle({ kind: "completed", output: finalOutput });
			return;
		}
		settle({
			kind: "crashed",
			error: signal ? `Reviewer was killed by ${signal}.` : `Reviewer exited with code ${code}.`,
		});
	});

	return { done, cancel: () => killTree("cancelled") };
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
		settle({ kind: "completed", output: summary.latestHookActivity?.finalMessage ?? "" });
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
			settle({ kind: "crashed", error: error instanceof Error ? error.message : String(error) });
		});

	return { done, cancel: () => settle({ kind: "cancelled" }) };
}
