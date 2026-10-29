import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function spawnSourceCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
	return spawn(
		process.execPath,
		["--import", resolveTsxLoaderImportSpecifier(), resolve(process.cwd(), "src/cli.ts"), ...args],
		{
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
}

async function runCliCommand(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }) {
	const child = spawnSourceCli(args, options);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const didExit = await waitForExit(child, options.timeoutMs ?? 8_000);
	if (!didExit) {
		child.kill("SIGKILL");
	}
	return { stdout, stderr, exitCode: child.exitCode, didExit };
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null) {
		return true;
	}
	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			child.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		child.once("exit", handleExit);
	});
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

async function waitForServerStart(process: ChildProcess, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolveStart, rejectStart) => {
		if (!process.stdout || !process.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			if (!stdout.includes("Cline Kanban running at ") || settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart();
		};
		process.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		process.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		process.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function commitAll(cwd: string, message: string): void {
	for (const args of [
		["add", "."],
		["commit", "-qm", message],
	]) {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			env: createGitTestEnv(),
		});
		if (result.status !== 0) {
			throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
		}
	}
}

describe("cli compatibility flags", () => {
	it("accepts the deprecated --agent flag as a no-op", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"--agent",
				"legacy-alias-value",
				"--help",
			],
			{
				encoding: "utf8",
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("--port");
		expect(result.stdout).not.toContain("--agent");
		expect(result.stdout).not.toContain("Agent IDs:");
	});

	it("exposes the task send flags", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"task",
				"send",
				"--help",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--task-id <id>");
		expect(result.stdout).toContain("--message <text>");
	});

	it("exposes the agent review task flag", () => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				resolveTsxLoaderImportSpecifier(),
				resolve(process.cwd(), "src/cli.ts"),
				"task",
				"create",
				"--help",
			],
			{ encoding: "utf8" },
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--agent-review-enabled [value]");
	});

	it("stores agent review when creating a task", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-cli-compat-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-cli-compat-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# CLI Compat Test\n", "utf8");
			commitAll(projectPath, "init");

			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: String(await getAvailablePort()),
			});

			const serverProcess = spawn(
				process.execPath,
				["--import", resolveTsxLoaderImportSpecifier(), resolve(process.cwd(), "src/cli.ts"), "--no-open"],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const created = await runCliCommand(
					[
						"task",
						"create",
						"--prompt",
						"Add a reviewable banner to the homepage with a welcome message",
						"--agent-review-enabled",
						"true",
						"--project-path",
						projectPath,
					],
					{ cwd: projectPath, env },
				);
				expect(created.didExit).toBe(true);
				expect(created.exitCode).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as { task: { id: string; agentReviewEnabled: boolean } };
				expect(createdPayload.task.agentReviewEnabled).toBe(true);

				const listed = await runCliCommand(["task", "list", "--column", "backlog", "--project-path", projectPath], {
					cwd: projectPath,
					env,
				});
				expect(listed.didExit).toBe(true);
				expect(listed.exitCode).toBe(0);
				const listedPayload = JSON.parse(listed.stdout) as {
					tasks: Array<{ id: string; agentReviewEnabled: boolean; reviewRound: number }>;
				};
				const stored = listedPayload.tasks.find((task) => task.id === createdPayload.task.id);
				expect(stored?.agentReviewEnabled).toBe(true);
				expect(stored?.reviewRound).toBe(0);
			} finally {
				serverProcess.kill("SIGINT");
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
