import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildReviewerCommand, startReviewerRun } from "../../../src/agent-review/reviewer-runner";
import type { StartClineTaskSessionRequest } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "kanban-reviewer-runner-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// Runs `script` with node in place of the real agent binary.
function fakeAgent(script: string) {
	const calls: Array<{ command: string; args: string[] }> = [];
	const spawnImpl = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
		calls.push({ command, args });
		return spawn(process.execPath, ["-e", script], options);
	};
	return { calls, spawnImpl };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) {
			throw new Error("waitFor timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

// Fake agent that starts a long-lived grandchild, writes its pid to a file, then hangs.
function treeScript(pidFile: string): string {
	return `
		const { spawn } = require("node:child_process");
		const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
		require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
		setInterval(() => {}, 1000);
	`;
}

function readPid(pidFile: string): number {
	try {
		return Number(readFileSync(pidFile, "utf8"));
	} catch {
		return 0;
	}
}

const baseInput = {
	prompt: "review this",
	timeoutMs: 10_000,
	isAgentInstalled: () => true,
	reviewKey: "agent-review:t1",
};

describe("buildReviewerCommand", () => {
	it("buildReviewerCommand matches the confirmed argv table", () => {
		expect(buildReviewerCommand("claude")).toEqual({
			binary: "claude",
			args: [
				"-p",
				"--strict-mcp-config",
				"--mcp-config",
				'{"mcpServers":{}}',
				"--output-format",
				"text",
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
		});
		expect(buildReviewerCommand("codex")).toEqual({
			binary: "codex",
			args: ["exec", "-", "--dangerously-bypass-approvals-and-sandbox"],
			promptVia: "stdin",
		});
		expect(buildReviewerCommand("droid")).toEqual({
			binary: "droid",
			args: ["exec", "--auto", "high"],
			promptVia: "arg",
		});
		expect(buildReviewerCommand("kiro")).toEqual({
			binary: "kiro-cli",
			args: ["chat", "--no-interactive", "--trust-all-tools"],
			promptVia: "arg",
		});
		expect(buildReviewerCommand("cline")).toBeNull();
		expect(buildReviewerCommand("gemini")).toBeNull();
		expect(buildReviewerCommand("opencode")).toEqual({
			binary: "opencode",
			args: ["run", "--standalone", "--auto"],
			promptVia: "arg",
			env: {
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					permissions: [
						{ action: "edit", resource: "*", effect: "deny" },
						{ action: "question", resource: "*", effect: "deny" },
					],
				}),
			},
		});
	});
});

describe("startReviewerRun", () => {
	it("returns completed with stdout", async () => {
		const fake = fakeAgent(`
			let input = "";
			process.stdin.on("data", (chunk) => { input += chunk; });
			process.stdin.on("end", () => { process.stdout.write("got: " + input); });
		`);
		const handle = startReviewerRun({ ...baseInput, agentId: "claude", cwd: tempDir, spawnImpl: fake.spawnImpl });
		await expect(handle.done).resolves.toEqual({ kind: "completed", output: "got: review this" });
		expect(fake.calls[0]?.command).toBe("claude");
	});

	it("streams stdout and stderr to onOutput as it arrives", async () => {
		const fake = fakeAgent(`process.stdout.write("out "); process.stderr.write("err");`);
		const chunks: string[] = [];
		const handle = startReviewerRun({
			...baseInput,
			agentId: "kiro",
			cwd: tempDir,
			spawnImpl: fake.spawnImpl,
			onOutput: (chunk) => chunks.push(chunk),
		});
		await handle.done;
		expect(chunks.join("").split(" ").sort()).toEqual(["err", "out"]);
	});

	it("passes the prompt as the last argument for arg agents", async () => {
		const fake = fakeAgent(`process.stdout.write("ok")`);
		const handle = startReviewerRun({ ...baseInput, agentId: "kiro", cwd: tempDir, spawnImpl: fake.spawnImpl });
		await expect(handle.done).resolves.toEqual({ kind: "completed", output: "ok" });
		expect(fake.calls[0]?.args.at(-1)).toBe("review this");
	});

	it("runs opencode with the prompt as an arg, the read-only config and PWD set to cwd", async () => {
		const fake = fakeAgent(
			`process.stdout.write(JSON.stringify({ config: process.env.OPENCODE_CONFIG_CONTENT, pwd: process.env.PWD }))`,
		);
		const handle = startReviewerRun({ ...baseInput, agentId: "opencode", cwd: tempDir, spawnImpl: fake.spawnImpl });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("completed");
		const env = outcome.kind === "completed" ? JSON.parse(outcome.output) : null;
		expect(JSON.parse(env.config).permissions[0]).toEqual({ action: "edit", resource: "*", effect: "deny" });
		expect(env.pwd).toBe(tempDir);
		expect(fake.calls[0]).toEqual({
			command: "opencode",
			args: ["run", "--standalone", "--auto", "review this"],
		});
	});

	it("returns crashed on a non-zero exit with no output", async () => {
		const fake = fakeAgent(`process.exit(3)`);
		const handle = startReviewerRun({ ...baseInput, agentId: "claude", cwd: tempDir, spawnImpl: fake.spawnImpl });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("crashed");
	});

	it("returns completed on a non-zero exit with output", async () => {
		const fake = fakeAgent(`process.stdout.write("partial"); process.exitCode = 1;`);
		const handle = startReviewerRun({ ...baseInput, agentId: "claude", cwd: tempDir, spawnImpl: fake.spawnImpl });
		await expect(handle.done).resolves.toEqual({ kind: "completed", output: "partial" });
	});

	it("times out and kills the whole process tree", async () => {
		const pidFile = join(tempDir, "grandchild.pid");
		const fake = fakeAgent(treeScript(pidFile));
		const handle = startReviewerRun({
			...baseInput,
			agentId: "claude",
			cwd: tempDir,
			timeoutMs: 1000,
			spawnImpl: fake.spawnImpl,
		});
		await expect(handle.done).resolves.toEqual({ kind: "timeout" });
		const grandPid = readPid(pidFile);
		expect(grandPid).toBeGreaterThan(0);
		await waitFor(() => !isAlive(grandPid));
		expect(() => process.kill(grandPid, 0)).toThrow();
	});

	it("cancel() resolves cancelled and kills the tree", async () => {
		const pidFile = join(tempDir, "grandchild.pid");
		const fake = fakeAgent(treeScript(pidFile));
		const handle = startReviewerRun({ ...baseInput, agentId: "claude", cwd: tempDir, spawnImpl: fake.spawnImpl });
		await waitFor(() => readPid(pidFile) > 0);
		handle.cancel();
		await expect(handle.done).resolves.toEqual({ kind: "cancelled" });
		const grandPid = readPid(pidFile);
		await waitFor(() => !isAlive(grandPid));
		expect(() => process.kill(grandPid, 0)).toThrow();
	});

	it("cancel() settles even when an orphaned grandchild still holds the output pipes", async () => {
		const pidFile = join(tempDir, "grandchild.pid");
		// The agent starts a background process (like a dev server) and exits; the orphan keeps stdout open.
		const fake = fakeAgent(`
			const { spawn } = require("node:child_process");
			const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
			require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
			process.exit(0);
		`);
		const handle = startReviewerRun({ ...baseInput, agentId: "claude", cwd: tempDir, spawnImpl: fake.spawnImpl });
		await waitFor(() => readPid(pidFile) > 0);
		const grandPid = readPid(pidFile);
		try {
			await new Promise((resolve) => setTimeout(resolve, 200));
			handle.cancel();
			const outcome = await Promise.race([
				handle.done,
				new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
			]);
			expect(outcome).toEqual({ kind: "cancelled" });
			await waitFor(() => !isAlive(grandPid));
		} finally {
			if (isAlive(grandPid)) {
				process.kill(grandPid, "SIGKILL");
			}
		}
	});

	it("returns unavailable when the agent is not installed", async () => {
		const fake = fakeAgent(`process.stdout.write("should not run")`);
		const handle = startReviewerRun({
			...baseInput,
			agentId: "claude",
			cwd: tempDir,
			isAgentInstalled: () => false,
			spawnImpl: fake.spawnImpl,
		});
		const outcome = await handle.done;
		expect(outcome.kind).toBe("unavailable");
		expect(fake.calls).toHaveLength(0);
	});

	it("returns unavailable for gemini (not launch-supported)", async () => {
		const fake = fakeAgent(`process.stdout.write("should not run")`);
		const handle = startReviewerRun({ ...baseInput, agentId: "gemini", cwd: tempDir, spawnImpl: fake.spawnImpl });
		const outcome = await handle.done;
		expect(outcome.kind).toBe("unavailable");
		expect(fake.calls).toHaveLength(0);
	});

	it("cline run uses reviewKey, never the task id", async () => {
		const listeners = new Set<(summary: RuntimeTaskSessionSummary) => void>();
		const started: StartClineTaskSessionRequest[] = [];
		const stopped: string[] = [];
		const summary = (
			state: RuntimeTaskSessionSummary["state"],
			finalMessage: string | null,
		): RuntimeTaskSessionSummary => ({
			taskId: "agent-review:t1",
			state,
			agentId: "cline",
			workspacePath: tempDir,
			pid: null,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: null,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: finalMessage
				? {
						activityText: null,
						toolName: null,
						toolInputSummary: null,
						finalMessage,
						hookEventName: null,
						notificationType: null,
						source: null,
					}
				: null,
		});
		const clineService = {
			onSummary(listener: (summary: RuntimeTaskSessionSummary) => void) {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			async startTaskSession(request: StartClineTaskSessionRequest) {
				started.push(request);
				return summary("running", null);
			},
			async stopTaskSession(taskId: string) {
				stopped.push(taskId);
				return null;
			},
			getSummary: () => summary("running", null),
		};
		const handle = startReviewerRun({ ...baseInput, agentId: "cline", cwd: tempDir, clineService });
		await waitFor(() => started.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const listener of listeners) {
			listener(summary("awaiting_review", "verdict"));
		}
		await expect(handle.done).resolves.toEqual({ kind: "completed", output: "verdict" });
		expect(started[0]).toMatchObject({ taskId: "agent-review:t1", cwd: tempDir, prompt: "review this", mode: "act" });
		expect(stopped).toEqual(["agent-review:t1"]);
		expect(listeners.size).toBe(0);
	});
});
