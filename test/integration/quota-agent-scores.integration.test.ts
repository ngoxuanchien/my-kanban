import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardData,
	RuntimeProjectsResponse,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);
const taskId = "review-task";

function createReviewBoard(): RuntimeBoardData {
	const now = Date.now();
	const makeCard = (id: string, handOffCount = 0) => ({
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: now,
		updatedAt: now,
		agentId: "codex" as const,
		agentReviewEnabled: true,
		reviewRound: 1,
		handOffCount,
	});
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [makeCard(taskId, 2), makeCard("other-review-task")],
			},
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
	if (!port) throw new Error("Could not allocate a test port.");
	return port;
}

function initGitRepository(path: string): void {
	for (const args of [["init"], ["checkout", "-B", "main"]]) {
		const result = spawnSync("git", args, { cwd: path, stdio: "ignore", env: createGitTestEnv() });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${path}`);
	}
}

function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

async function waitForServer(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolveStart, reject) => {
		let output = "";
		const timeout = setTimeout(() => reject(new Error(`Runtime did not start.\n${output}`)), 10_000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("Cline Kanban running at ")) {
				clearTimeout(timeout);
				resolveStart();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`Runtime exited before startup (${String(code)}).\n${output}`));
		});
	});
}

async function stopServer(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.send?.({ type: "kanban.shutdown" });
	const stopped = await new Promise<boolean>((resolveExit) => {
		const timeout = setTimeout(() => resolveExit(false), 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveExit(true);
		});
	});
	if (!stopped) child.kill("SIGKILL");
}

async function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
	const child = spawn(
		process.execPath,
		["--import", resolveTsxLoaderImportSpecifier(), resolve(process.cwd(), "src/cli.ts"), ...args],
		{ cwd, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exitCode = await new Promise<number | null>((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
		}, 8_000);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
	return { stdout, stderr, exitCode };
}

async function request<T>(input: {
	baseUrl: string;
	procedure: string;
	type: "query" | "mutation";
	workspaceId?: string;
	payload?: unknown;
}): Promise<{ status: number; payload: T }> {
	const url = `${input.baseUrl}/api/trpc/${input.procedure}${
		input.type === "query" && input.payload !== undefined
			? `?input=${encodeURIComponent(JSON.stringify(input.payload))}`
			: ""
	}`;
	const response = await fetch(url, {
		method: input.type === "query" ? "GET" : "POST",
		headers: {
			...(input.workspaceId ? { "x-kanban-workspace-id": input.workspaceId } : {}),
			...(input.type === "mutation" ? { "Content-Type": "application/json" } : {}),
		},
		...(input.type === "mutation" && input.payload !== undefined ? { body: JSON.stringify(input.payload) } : {}),
	});
	const envelope: unknown = await response.json();
	const result = Array.isArray(envelope) ? envelope[0] : envelope;
	const data = result && typeof result === "object" && "result" in result ? result.result : undefined;
	return {
		status: response.status,
		payload: (data && typeof data === "object" && "data" in data
			? ((data.data as { json?: T }).json ?? data.data)
			: result) as T,
	};
}

async function withRuntime<T>(
	run: (input: {
		homeDir: string;
		projectPath: string;
		workspaceId: string;
		baseUrl: string;
		env: NodeJS.ProcessEnv;
	}) => Promise<T>,
): Promise<T> {
	const home = createTempDir("kanban-home-quota-score-");
	const project = createTempDir("kanban-project-quota-score-");
	initGitRepository(project.path);
	const port = await getAvailablePort();
	const env = createGitTestEnv({
		HOME: home.path,
		USERPROFILE: home.path,
		KANBAN_RUNTIME_PORT: String(port),
	});
	const server = spawn(
		process.execPath,
		[
			"--require",
			resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs"),
			"--import",
			resolveTsxLoaderImportSpecifier(),
			resolve(process.cwd(), "src/cli.ts"),
			"--no-open",
		],
		{ cwd: project.path, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
	);
	try {
		await waitForServer(server);
		const initialized = await runCli(["task", "list", "--project-path", project.path], project.path, env);
		if (initialized.exitCode !== 0)
			throw new Error(`Could not initialize runtime workspace.\n${initialized.stdout}\n${initialized.stderr}`);
		const projects = await request<RuntimeProjectsResponse>({
			baseUrl: `http://127.0.0.1:${port}`,
			procedure: "projects.list",
			type: "query",
		});
		const workspaceId = projects.payload.currentProjectId;
		if (!workspaceId) throw new Error(`Workspace was not indexed: ${JSON.stringify(projects.payload)}`);
		return await run({
			homeDir: home.path,
			projectPath: project.path,
			workspaceId,
			baseUrl: `http://127.0.0.1:${port}`,
			env,
		});
	} finally {
		await stopServer(server);
		project.cleanup();
		home.cleanup();
	}
}

describe("quota and agent score integration", () => {
	it("records review score events once per round and exposes the scoreboard", { timeout: 60_000 }, async () => {
		await withRuntime(async ({ homeDir, projectPath, workspaceId, baseUrl, env }) => {
			const state = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(state.status, JSON.stringify(state.payload)).toBe(200);
			const board = createReviewBoard();
			const seeded = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: { board, sessions: state.payload.sessions, expectedRevision: state.payload.revision },
			});
			expect(seeded.status).toBe(200);

			const failed = await runCli(
				["task", "review-failed", "--task-id", taskId, "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(failed.exitCode).toBe(0);
			expect(JSON.parse(failed.stdout).recorded).toBe(true);
			const duplicate = await runCli(
				["task", "review-failed", "--task-id", taskId, "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(duplicate.exitCode).toBe(0);
			expect(JSON.parse(duplicate.stdout).recorded).toBe(false);

			const current = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			const bumpedBoard = structuredClone(current.payload.board);
			const review = bumpedBoard.columns.find((column) => column.id === "review");
			const card = review?.cards.find((candidate) => candidate.id === taskId);
			if (!card) throw new Error("Seeded review task disappeared.");
			card.reviewRound = 2;
			const bumped = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: {
					board: bumpedBoard,
					sessions: current.payload.sessions,
					expectedRevision: current.payload.revision,
				},
			});
			expect(bumped.status).toBe(200);
			const failedRoundTwo = await runCli(
				["task", "review-failed", "--task-id", taskId, "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(failedRoundTwo.exitCode).toBe(0);
			expect(JSON.parse(failedRoundTwo.stdout).recorded).toBe(true);
			const listed = await runCli(
				["task", "list", "--column", "review", "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(listed.exitCode).toBe(0);
			const listJson = JSON.parse(listed.stdout) as { tasks: Array<{ id: string; handOffCount: number }> };
			expect(listJson.tasks).toHaveLength(2);
			expect(listJson.tasks.every((task) => typeof task.handOffCount === "number")).toBe(true);
			expect(listJson.tasks.find((task) => task.id === taskId)?.handOffCount).toBe(2);

			const noPass = await runCli(
				["task", "done", "--task-id", "other-review-task", "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(noPass.exitCode).toBe(0);
			const doneWithPass = await runCli(
				["task", "done", "--task-id", taskId, "--review-passed", "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(doneWithPass.exitCode).toBe(0);

			const invalidPass = await runCli(
				["task", "done", "--column", "review", "--review-passed", "--project-path", projectPath],
				projectPath,
				env,
			);
			expect(invalidPass.exitCode).not.toBe(0);
			expect(`${invalidPass.stdout}${invalidPass.stderr}`).toContain("--review-passed requires --task-id");

			const trashed = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(
				trashed.payload.board.columns
					.find((column) => column.id === "trash")
					?.cards.some((card) => card.id === taskId),
			).toBe(true);
			const scorePath = join(homeDir, ".cline", "kanban", "workspaces", workspaceId, "agent-scores.json");
			const scores = JSON.parse(readFileSync(scorePath, "utf8")) as {
				version: number;
				events: Array<{ type: string; agentId: string; taskId: string; round?: number }>;
			};
			expect(scores.version).toBe(1);
			expect(
				scores.events
					.filter((event) => event.agentId === "codex")
					.map(({ type }) => type)
					.sort(),
			).toEqual(["assigned", "fail", "fail", "pass"]);
			expect(
				scores.events
					.filter((event) => event.type === "fail")
					.map(({ round }) => round)
					.sort(),
			).toEqual([1, 2]);
			expect(trashed.payload.agentScores).toEqual([{ agentId: "codex", score: -1, passes: 1, fails: 2, tasks: 1 }]);
		});
	});

	it("preserves quotaBlockedAt through the runtime full-board save path", { timeout: 60_000 }, async () => {
		await withRuntime(async ({ workspaceId, baseUrl }) => {
			const state = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			const board = createReviewBoard();
			const reviewTask = board.columns
				.find((column) => column.id === "review")
				?.cards.find((card) => card.id === taskId);
			if (!reviewTask) throw new Error("Missing seeded review task.");
			reviewTask.quotaBlockedAt = 1_700_000_000_000;
			const saved = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.saveState",
				type: "mutation",
				workspaceId,
				payload: { board, sessions: state.payload.sessions, expectedRevision: state.payload.revision },
			});
			expect(saved.status).toBe(200);
			const reloaded = await request<RuntimeWorkspaceStateResponse>({
				baseUrl,
				procedure: "workspace.getState",
				type: "query",
				workspaceId,
			});
			expect(
				reloaded.payload.board.columns
					.find((column) => column.id === "review")
					?.cards.find((card) => card.id === taskId)?.quotaBlockedAt,
			).toBe(1_700_000_000_000);
		});
	});
});
