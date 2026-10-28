import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildReviewerLaunch,
	REVIEWER_EXIT_GRACE_MS,
	type ReviewerTerminalManager,
	startReviewerRun,
} from "../../../src/agent-review/reviewer-runner";
import type { StartClineTaskSessionRequest } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import type { StartTaskSessionRequest } from "../../../src/terminal/session-manager";
import type { TerminalSessionListener } from "../../../src/terminal/terminal-session-service";

let tempDir: string;
let verdictPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kanban-reviewer-runner-"));
	verdictPath = join(tempDir, "verdict.json");
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(tempDir, { recursive: true, force: true });
});

const VALID_VERDICT = JSON.stringify({
	verdict: "cannot_verify",
	appVerified: false,
	appCheck: "no app",
	tests: [],
	summary: null,
	fixPrompt: null,
	notes: null,
});

function summary(patch: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "agent-review:t1",
		state: "running",
		agentId: "claude",
		workspacePath: tempDir,
		pid: 1,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...patch,
	};
}

const TURN_END = summary({
	state: "awaiting_review",
	reviewReason: "hook",
	latestHookActivity: {
		activityText: null,
		toolName: null,
		toolInputSummary: null,
		finalMessage: null,
		hookEventName: "Stop",
		notificationType: null,
		source: "claude",
	},
});

const NEEDS_USER = summary({ state: "awaiting_review", reviewReason: "attention" });

// Stands in for TerminalSessionManager: records launches and lets the test drive state and exit.
function fakeTerminalManager(options: { exitOnStop?: boolean; startError?: Error } = {}) {
	const started: StartTaskSessionRequest[] = [];
	const stopped: string[] = [];
	const listeners = new Set<TerminalSessionListener>();
	let resolveStart: (() => void) | null = null;
	let holdStart = false;
	const emitExit = (code: number | null) => {
		for (const listener of [...listeners]) {
			listener.onExit?.(code);
		}
	};
	const manager: ReviewerTerminalManager = {
		startTaskSession: async (request) => {
			started.push(request);
			if (options.startError) {
				throw options.startError;
			}
			if (holdStart) {
				await new Promise<void>((resolve) => {
					resolveStart = resolve;
				});
			}
			return summary();
		},
		stopTaskSession: (taskId) => {
			stopped.push(taskId);
			if (options.exitOnStop ?? true) {
				setTimeout(() => emitExit(null), 0);
			}
			return null;
		},
		attach: (_taskId, listener) => {
			listeners.add(listener);
			listener.onState?.(summary());
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		manager,
		started,
		stopped,
		listeners,
		holdStart: () => {
			holdStart = true;
		},
		releaseStart: () => resolveStart?.(),
		emitState: (next: RuntimeTaskSessionSummary) => {
			for (const listener of [...listeners]) {
				listener.onState?.(next);
			}
		},
		emitExit,
	};
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isSettled(promise: Promise<unknown>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
	]);
}

function runInput(terminalManager: ReviewerTerminalManager) {
	return {
		agentId: "claude" as const,
		workspaceId: "ws1",
		cwd: tempDir,
		prompt: "review this",
		verdictPath,
		timeoutMs: 10_000,
		isAgentInstalled: () => true,
		terminalManager,
		reviewKey: "agent-review:t1",
		pollIntervalMs: 20,
	};
}

describe("buildReviewerLaunch", () => {
	it("matches the confirmed argv table", () => {
		expect(buildReviewerLaunch("claude", "/tmp/v")).toEqual({
			binary: "claude",
			args: [
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--allowedTools",
				"Bash,Read,Grep,Glob",
				"--disallowedTools",
				"Edit,Write,NotebookEdit",
				"--add-dir",
				"/tmp/v",
			],
		});
		expect(buildReviewerLaunch("codex", "/tmp/v")).toEqual({ binary: "codex", args: [] });
		expect(buildReviewerLaunch("droid", "/tmp/v")).toEqual({ binary: "droid", args: [] });
		expect(buildReviewerLaunch("kiro", "/tmp/v")).toEqual({ binary: "kiro-cli", args: ["chat"] });
		expect(buildReviewerLaunch("opencode", "/tmp/v")).toEqual({
			binary: "opencode",
			args: [],
			env: {
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					permissions: [
						{ action: "edit", resource: "*", effect: "deny" },
						{ action: "question", resource: "*", effect: "deny" },
					],
				}),
			},
		});
		expect(buildReviewerLaunch("cline", "/tmp/v")).toBeNull();
		expect(buildReviewerLaunch("gemini", "/tmp/v")).toBeNull();
	});
});

describe("startReviewerRun (PTY)", () => {
	it("launches an interactive session under the review key that never auto-restarts", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		expect(fake.started[0]).toMatchObject({
			taskId: "agent-review:t1",
			agentId: "claude",
			binary: "claude",
			cwd: tempDir,
			prompt: "review this",
			autonomousModeEnabled: true,
			workspaceId: "ws1",
			disableAutoRestart: true,
			suppressAlternateScreen: true,
		});
		expect(fake.started[0]?.args).toContain(tempDir);
		handle.cancel();
		await handle.done;
	});

	it("ends the session once a valid verdict file appears, and resolves after the process exits", async () => {
		const fake = fakeTerminalManager({ exitOnStop: false });
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		writeFileSync(verdictPath, VALID_VERDICT);
		await waitFor(() => fake.stopped.length === 1);
		expect(await isSettled(handle.done)).toBe(false);
		fake.emitExit(null);
		await expect(handle.done).resolves.toEqual({ kind: "completed", verdict: VALID_VERDICT });
		expect(fake.listeners.size).toBe(0);
	});

	it("keeps waiting while the verdict file is malformed, then reports it at the turn end", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		writeFileSync(verdictPath, '{"verdict": ');
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(fake.stopped).toEqual([]);
		fake.emitState(TURN_END);
		await expect(handle.done).resolves.toEqual({ kind: "completed", verdict: '{"verdict": ' });
		expect(fake.stopped).toEqual(["agent-review:t1"]);
	});

	it("ends at the turn end without a verdict file", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		fake.emitState(TURN_END);
		await expect(handle.done).resolves.toEqual({ kind: "completed", verdict: null });
		expect(fake.stopped).toEqual(["agent-review:t1"]);
	});

	it("leaves a session waiting on the user running until the timeout", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun({ ...runInput(fake.manager), timeoutMs: 150 });
		await waitFor(() => fake.listeners.size === 1);
		fake.emitState(NEEDS_USER);
		expect(await isSettled(handle.done)).toBe(false);
		await expect(handle.done).resolves.toEqual({ kind: "timeout" });
		expect(fake.stopped).toEqual(["agent-review:t1"]);
	});

	it("reports a crash when the process exits non-zero without a verdict", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		fake.emitExit(2);
		await expect(handle.done).resolves.toEqual({ kind: "crashed", error: "Reviewer exited with code 2." });
		expect(fake.stopped).toEqual([]);
	});

	it("reads the verdict when the process exits on its own", async () => {
		const fake = fakeTerminalManager();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		writeFileSync(verdictPath, "not json");
		fake.emitExit(1);
		await expect(handle.done).resolves.toEqual({ kind: "completed", verdict: "not json" });
	});

	it("reports a crash when the session cannot start", async () => {
		const fake = fakeTerminalManager({ startError: new Error('Failed to launch "claude".') });
		const handle = startReviewerRun(runInput(fake.manager));
		await expect(handle.done).resolves.toEqual({ kind: "crashed", error: 'Failed to launch "claude".' });
	});

	it("cancel() stops the session and resolves once it exited", async () => {
		const fake = fakeTerminalManager({ exitOnStop: false });
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.listeners.size === 1);
		handle.cancel();
		expect(fake.stopped).toEqual(["agent-review:t1"]);
		expect(await isSettled(handle.done)).toBe(false);
		fake.emitExit(null);
		await expect(handle.done).resolves.toEqual({ kind: "cancelled" });
	});

	it("cancel() resolves after a grace period when the process never exits", async () => {
		vi.useFakeTimers();
		const fake = fakeTerminalManager({ exitOnStop: false });
		const handle = startReviewerRun(runInput(fake.manager));
		await vi.waitFor(() => expect(fake.listeners.size).toBe(1));
		handle.cancel();
		await vi.advanceTimersByTimeAsync(REVIEWER_EXIT_GRACE_MS);
		await expect(handle.done).resolves.toEqual({ kind: "cancelled" });
	});

	it("cancel() while the session is starting stops it once it has started", async () => {
		const fake = fakeTerminalManager();
		fake.holdStart();
		const handle = startReviewerRun(runInput(fake.manager));
		await waitFor(() => fake.started.length === 1);
		handle.cancel();
		expect(fake.stopped).toEqual([]);
		fake.releaseStart();
		await expect(handle.done).resolves.toEqual({ kind: "cancelled" });
		expect(fake.stopped).toEqual(["agent-review:t1"]);
	});

	it("returns unavailable when the agent is not installed or not launch-supported", async () => {
		const fake = fakeTerminalManager();
		await expect(
			startReviewerRun({ ...runInput(fake.manager), isAgentInstalled: () => false }).done,
		).resolves.toMatchObject({ kind: "unavailable" });
		await expect(startReviewerRun({ ...runInput(fake.manager), agentId: "gemini" }).done).resolves.toMatchObject({
			kind: "unavailable",
		});
		expect(fake.started).toEqual([]);
	});
});

describe("startReviewerRun (Cline)", () => {
	it("uses reviewKey, never the task id, and reads the verdict file when the session stops", async () => {
		const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
		const started: StartClineTaskSessionRequest[] = [];
		const stopped: string[] = [];
		const clineSummary = (state: RuntimeTaskSessionSummary["state"]) => summary({ agentId: "cline", state });
		const clineService = {
			onSummary(listener: (summary: RuntimeTaskSessionSummary) => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			async startTaskSession(request: StartClineTaskSessionRequest) {
				started.push(request);
				return clineSummary("running");
			},
			async stopTaskSession(taskId: string) {
				stopped.push(taskId);
				return null;
			},
			getSummary: () => clineSummary("running"),
		};
		const handle = startReviewerRun({
			...runInput(fakeTerminalManager().manager),
			agentId: "cline",
			clineService,
		});
		await waitFor(() => started.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		writeFileSync(verdictPath, VALID_VERDICT);
		for (const listener of listeners) {
			listener(clineSummary("awaiting_review"));
		}
		await expect(handle.done).resolves.toEqual({ kind: "completed", verdict: VALID_VERDICT });
		expect(started[0]).toMatchObject({ taskId: "agent-review:t1", cwd: tempDir, prompt: "review this", mode: "act" });
		expect(stopped).toEqual(["agent-review:t1"]);
		expect(listeners.size).toBe(0);
	});
});
