import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type {
	RuntimeAgentReviewState,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeProjectRemoveResponse,
	RuntimeWorkspaceStateResponse,
} from "../../src/core/api-contract";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const requireFromHere = createRequire(import.meta.url);

type CardSpec = { card: RuntimeBoardCard; columnId: RuntimeBoardColumnId };

interface TestEnvironment {
	homeDir: string;
	rootDir: string;
	stubLogPath: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

interface KanbanServer {
	port: number;
	workspaceId: string;
	stop: () => Promise<void>;
}

function createCard(id: string, overrides: Partial<RuntimeBoardCard> = {}): RuntimeBoardCard {
	return {
		id,
		title: `Task ${id}`,
		prompt: `Do ${id}`,
		startInPlanMode: false,
		baseRef: "main",
		agentId: "claude",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function createAgentReviewState(overrides: Partial<RuntimeAgentReviewState> = {}): RuntimeAgentReviewState {
	return {
		status: "reviewing",
		round: 0,
		reason: null,
		reasonDetail: null,
		fingerprint: null,
		lastResult: null,
		fixPrompts: [],
		summary: null,
		meta: null,
		updatedAt: 1,
		...overrides,
	};
}

function createBoard(specs: CardSpec[], dependencies: RuntimeBoardDependency[] = []): RuntimeBoardData {
	const columns: RuntimeBoardData["columns"] = [
		{ id: "backlog", title: "Backlog", cards: [] },
		{ id: "in_progress", title: "In Progress", cards: [] },
		{ id: "review", title: "Review", cards: [] },
		{ id: "user_review", title: "Needs your review", cards: [] },
		{ id: "trash", title: "Done", cards: [] },
	];
	return {
		columns: columns.map((column) => ({
			...column,
			cards: specs.filter((spec) => spec.columnId === column.id).map((spec) => spec.card),
		})),
		dependencies,
	};
}

function findCard(board: RuntimeBoardData, taskId: string): CardSpec | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return { card, columnId: column.id };
		}
	}
	return null;
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function createProject(rootDir: string, name: string): string {
	const projectPath = join(rootDir, name);
	mkdirSync(projectPath, { recursive: true });
	runGit(projectPath, ["init", "-q", "-b", "main"]);
	writeFileSync(join(projectPath, "README.md"), `# ${name}\n`, "utf8");
	runGit(projectPath, ["add", "."]);
	runGit(projectPath, ["commit", "-qm", "init"]);
	return projectPath;
}

// Every agent the runtime launches in these tests is this stub. It logs "<pid> <args>" and stays alive.
function installClaudeStub(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const scriptPath = join(binDir, "claude");
	writeFileSync(scriptPath, '#!/bin/sh\necho "$$ $*" >> "$KANBAN_TEST_STUB_LOG"\nexec sleep 60\n', "utf8");
	chmodSync(scriptPath, 0o755);
}

function readStubLog(logPath: string): string[] {
	return existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : [];
}

function createTestEnvironment(prefix: string): TestEnvironment {
	const home = createTempDir(`kanban-home-${prefix}-`);
	const root = createTempDir(`kanban-projects-${prefix}-`);
	const binDir = join(root.path, "bin");
	const stubLogPath = join(root.path, "stub.log");
	installClaudeStub(binDir);
	return {
		homeDir: home.path,
		rootDir: root.path,
		stubLogPath,
		env: createGitTestEnv({
			HOME: home.path,
			USERPROFILE: home.path,
			PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
			KANBAN_TEST_STUB_LOG: stubLogPath,
		}),
		cleanup: () => {
			root.cleanup();
			home.cleanup();
		},
	};
}

// Kanban state lives under HOME, so seeding from this process swaps HOME for the call.
async function withHome<T>(homeDir: string, work: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	try {
		return await work();
	} finally {
		process.env.HOME = previousHome;
		process.env.USERPROFILE = previousUserProfile;
	}
}

async function seedBoard(
	homeDir: string,
	projectPath: string,
	board: RuntimeBoardData,
	worktreeTaskIds: string[] = [],
): Promise<{ workspaceId: string; revision: number }> {
	return await withHome(homeDir, async () => {
		const context = await loadWorkspaceContext(projectPath, { autoCreateIfMissing: true });
		const initial = await loadWorkspaceState(projectPath);
		const saved = await saveWorkspaceState(projectPath, {
			board,
			sessions: {},
			expectedRevision: initial.revision,
		});
		for (const taskId of worktreeTaskIds) {
			const ensured = await ensureTaskWorktreeIfDoesntExist({ cwd: projectPath, taskId, baseRef: "main" });
			if (!ensured.ok) {
				throw new Error(ensured.error ?? `Could not create worktree for ${taskId}.`);
			}
		}
		return { workspaceId: context.workspaceId, revision: saved.revision };
	});
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

function spawnSourceCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; ipc?: boolean }): ChildProcess {
	return spawn(
		process.execPath,
		[
			...(options.ipc ? ["--require", resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs")] : []),
			"--import",
			pathToFileURL(requireFromHere.resolve("tsx")).href,
			resolve(process.cwd(), "src/cli.ts"),
			...args,
		],
		{
			cwd: options.cwd,
			env: options.env,
			stdio: options.ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
		},
	);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) {
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

async function startKanbanServer(cwd: string, testEnv: TestEnvironment): Promise<KanbanServer> {
	const port = await getAvailablePort();
	const child = spawnSourceCli(["--no-open"], {
		cwd,
		env: { ...testEnv.env, KANBAN_RUNTIME_PORT: String(port) },
		ipc: true,
	});
	const workspaceId = await new Promise<string>((resolveStart, rejectStart) => {
		let output = "";
		const timeoutId = setTimeout(
			() => rejectStart(new Error(`Timed out waiting for server start.\n${output}`)),
			15_000,
		);
		const handleOutput = (chunk: Buffer) => {
			output += chunk.toString();
			const match = output.match(/Cline Kanban running at http:\/\/127\.0\.0\.1:\d+\/(\S+)/);
			if (match?.[1]) {
				clearTimeout(timeoutId);
				resolveStart(decodeURIComponent(match[1]));
			}
		};
		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);
		child.once("exit", (code) => {
			clearTimeout(timeoutId);
			rejectStart(new Error(`Server exited before startup (code=${String(code)}).\n${output}`));
		});
	});
	return {
		port,
		workspaceId,
		stop: async () => {
			if (child.connected) {
				child.send({ type: "kanban.shutdown" });
			} else {
				child.kill("SIGINT");
			}
			if (!(await waitForExit(child, 10_000))) {
				child.kill("SIGKILL");
				await waitForExit(child, 5_000);
			}
		},
	};
}

async function requestTrpc<T>(input: {
	port: number;
	procedure: string;
	type: "query" | "mutation";
	workspaceId: string;
	payload?: unknown;
}): Promise<{ status: number; payload: T }> {
	let url = `http://127.0.0.1:${input.port}/api/trpc/${input.procedure}`;
	const headers: Record<string, string> = { "x-kanban-workspace-id": input.workspaceId };
	const init: RequestInit = { headers };
	if (input.type === "query") {
		if (input.payload !== undefined) {
			url += `?input=${encodeURIComponent(JSON.stringify(input.payload))}`;
		}
	} else {
		headers["Content-Type"] = "application/json";
		init.method = "POST";
		init.body = JSON.stringify(input.payload ?? null);
	}
	const response = await fetch(url, init);
	const envelope = (await response.json()) as { result?: { data?: unknown }; error?: unknown };
	return { status: response.status, payload: (envelope.result?.data ?? envelope.error) as T };
}

async function getWorkspaceState(server: KanbanServer, workspaceId: string): Promise<RuntimeWorkspaceStateResponse> {
	const response = await requestTrpc<RuntimeWorkspaceStateResponse>({
		port: server.port,
		procedure: "workspace.getState",
		type: "query",
		workspaceId,
	});
	expect(response.status).toBe(200);
	return response.payload;
}

async function waitFor<T>(
	description: string,
	read: () => Promise<T | null> | T | null,
	timeoutMs = 15_000,
): Promise<T> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await read();
		if (value !== null) {
			return value;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForCardInColumn(
	server: KanbanServer,
	workspaceId: string,
	taskId: string,
	columnId: RuntimeBoardColumnId,
): Promise<RuntimeBoardCard> {
	return await waitFor(`${taskId} in ${columnId}`, async () => {
		const location = findCard((await getWorkspaceState(server, workspaceId)).board, taskId);
		return location?.columnId === columnId ? location.card : null;
	});
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// A card that was mid-review when the runtime stopped. It has no worktree, so the re-run fails and
// lands in user_review: proof that the service for that workspace started.
function createInterruptedReviewBoard(): RuntimeBoardData {
	return createBoard([
		{
			card: createCard("X", { agentReviewEnabled: true, agentReview: createAgentReviewState() }),
			columnId: "review",
		},
	]);
}

describe.sequential("agent review runtime integration", () => {
	it("starts agent review for a non-active registered workspace at runtime startup", { timeout: 60_000 }, async () => {
		const testEnv = createTestEnvironment("agent-review-startup");
		try {
			const activePath = createProject(testEnv.rootDir, "active");
			const otherPath = createProject(testEnv.rootDir, "other");
			const other = await seedBoard(testEnv.homeDir, otherPath, createInterruptedReviewBoard());

			const server = await startKanbanServer(activePath, testEnv);
			try {
				expect(server.workspaceId).not.toBe(other.workspaceId);
				const card = await waitForCardInColumn(server, other.workspaceId, "X", "user_review");
				expect(card.agentReview?.status).toBe("needs_user");
				expect(card.agentReview?.reason).toBe("reviewer_crashed");
			} finally {
				await server.stop();
			}
		} finally {
			testEnv.cleanup();
		}
	});

	it(
		"a browser save with an old revision gets a conflict and does not overwrite the runtime's agentReview write",
		{ timeout: 60_000 },
		async () => {
			const testEnv = createTestEnvironment("agent-review-conflict");
			try {
				const projectPath = createProject(testEnv.rootDir, "project");
				const staleBoard = createInterruptedReviewBoard();
				const seeded = await seedBoard(testEnv.homeDir, projectPath, staleBoard);

				const server = await startKanbanServer(projectPath, testEnv);
				try {
					await waitForCardInColumn(server, seeded.workspaceId, "X", "user_review");

					const staleSave = await requestTrpc<unknown>({
						port: server.port,
						procedure: "workspace.saveState",
						type: "mutation",
						workspaceId: seeded.workspaceId,
						payload: { board: staleBoard, sessions: {}, expectedRevision: seeded.revision },
					});
					expect(staleSave.status).toBe(409);

					const location = findCard((await getWorkspaceState(server, seeded.workspaceId)).board, "X");
					expect(location?.columnId).toBe("user_review");
					expect(location?.card.agentReview?.reason).toBe("reviewer_crashed");
				} finally {
					await server.stop();
				}
			} finally {
				testEnv.cleanup();
			}
		},
	);

	it(
		"removing a project disposes its agent review service and kills a running reviewer",
		{ timeout: 60_000 },
		async () => {
			const testEnv = createTestEnvironment("agent-review-remove");
			try {
				const activePath = createProject(testEnv.rootDir, "active");
				const otherPath = createProject(testEnv.rootDir, "other");
				const other = await seedBoard(
					testEnv.homeDir,
					otherPath,
					createBoard([
						{
							card: createCard("X", {
								agentReviewEnabled: true,
								agentReview: createAgentReviewState({ status: "queued" }),
							}),
							columnId: "review",
						},
					]),
					["X"],
				);

				const server = await startKanbanServer(activePath, testEnv);
				try {
					const reviewerPid = await waitFor("the reviewer process", () => {
						const line = readStubLog(testEnv.stubLogPath).find((entry) =>
							entry.includes("--disallowedTools Edit,Write,NotebookEdit"),
						);
						return line ? Number(line.split(" ")[0]) : null;
					});
					expect(isProcessAlive(reviewerPid)).toBe(true);

					const removed = await requestTrpc<RuntimeProjectRemoveResponse>({
						port: server.port,
						procedure: "projects.remove",
						type: "mutation",
						workspaceId: server.workspaceId,
						payload: { projectId: other.workspaceId },
					});
					expect(removed.payload.ok).toBe(true);

					await waitFor("the reviewer to be killed", () => (isProcessAlive(reviewerPid) ? null : true));
				} finally {
					await server.stop();
				}
			} finally {
				testEnv.cleanup();
			}
		},
	);

	it("CLI task trash from user_review starts dependents", { timeout: 60_000 }, async () => {
		const testEnv = createTestEnvironment("agent-review-cli-trash");
		try {
			const projectPath = createProject(testEnv.rootDir, "project");
			const seeded = await seedBoard(
				testEnv.homeDir,
				projectPath,
				createBoard(
					[
						{
							card: createCard("X", {
								agentReviewEnabled: true,
								agentReview: createAgentReviewState({ status: "needs_user", reason: "round_limit" }),
							}),
							columnId: "user_review",
						},
						{ card: createCard("Y"), columnId: "backlog" },
					],
					[{ id: "dep-1", fromTaskId: "Y", toTaskId: "X", createdAt: 1 }],
				),
			);

			const server = await startKanbanServer(projectPath, testEnv);
			try {
				const command = spawnSourceCli(["task", "trash", "--task-id", "X", "--project-path", projectPath], {
					cwd: projectPath,
					env: { ...testEnv.env, KANBAN_RUNTIME_PORT: String(server.port) },
				});
				let stdout = "";
				let stderr = "";
				command.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				command.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				expect(await waitForExit(command, 20_000)).toBe(true);
				expect(command.exitCode, `${stdout}\n${stderr}`).toBe(0);
				const payload = JSON.parse(stdout) as { ok?: boolean; autoStartedTasks?: unknown[] };
				expect(payload.ok).toBe(true);
				expect(payload.autoStartedTasks).toHaveLength(1);

				const state = await getWorkspaceState(server, seeded.workspaceId);
				expect(findCard(state.board, "X")?.columnId).toBe("trash");
				expect(findCard(state.board, "Y")?.columnId).toBe("in_progress");
			} finally {
				await server.stop();
			}
		} finally {
			testEnv.cleanup();
		}
	});
});
