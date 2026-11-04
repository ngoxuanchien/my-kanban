import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { type GithubIssueMap, readGithubIssueMap, setGithubIssueSummary } from "../../../src/github/issue-map";
import { createGithubIssueSyncService, reconcileGithubIssues } from "../../../src/github/issue-sync";
import { createRuntimeStateHub } from "../../../src/server/runtime-state-hub";
import type * as WorkspaceStateModule from "../../../src/state/workspace-state";
import {
	getWorkspaceDirectoryPath,
	loadWorkspaceContext,
	loadWorkspaceState,
} from "../../../src/state/workspace-state";
import type { TerminalSessionManager } from "../../../src/terminal/session-manager";
import { type RuntimeTrpcContext, runtimeAppRouter } from "../../../src/trpc/app-router";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const mocks = vi.hoisted(() => ({ config: vi.fn(), board: vi.fn(), history: vi.fn() }));
vi.mock("../../../src/config/runtime-config", () => ({ loadRuntimeConfig: mocks.config }));
vi.mock("../../../src/state/workspace-state", async (original) => {
	const actual = await original<typeof WorkspaceStateModule>();
	return {
		...actual,
		loadWorkspaceBoardById: mocks.board,
		loadWorkspaceState: vi.fn(actual.loadWorkspaceState),
	};
});
vi.mock("../../../src/state/task-history", () => ({ loadTaskHistory: mocks.history }));
const input = { workspaceId: "issue-test", repoPath: "/repo" };
const secret = "PRIVATE PROMPT MUST NEVER LEAVE";
const task = {
	id: "one",
	title: "Public title",
	prompt: secret,
	agentId: "codex" as const,
	startInPlanMode: false,
	baseRef: "main",
	createdAt: 1,
	updatedAt: 1,
};
let temp: ReturnType<typeof createTempDir>;
let calls: string[][];
let mapPath: string;
const warn = vi.fn();
const runFakeGh = async (args: string[], options: { cwd: string }) => {
	expect(options.cwd).toBe(input.repoPath);
	calls.push(args);
	return { stdout: args[0] === "issue" && args[1] === "create" ? "https://github.com/o/r/issues/12\n" : "" };
};
const gh = vi.fn(runFakeGh);
const deps = { runGh: gh, warn };
function board(column: RuntimeBoardColumnId = "backlog"): RuntimeBoardData {
	return { columns: [{ id: column, title: column, cards: [task] }], dependencies: [] };
}
async function seed(map: GithubIssueMap) {
	await writeFile(mapPath, JSON.stringify(map));
}
const mapped = { issueNumber: 12, issueUrl: "https://github.com/o/r/issues/12", syncedColumn: "backlog" as const };
const reconcile = () => reconcileGithubIssues(input, deps);
beforeEach(async () => {
	temp = createTempDir("github-sync-");
	vi.stubEnv("HOME", temp.path);
	vi.stubEnv("USERPROFILE", temp.path);
	mapPath = join(getWorkspaceDirectoryPath(input.workspaceId), "github-issues.json");
	await mkdir(getWorkspaceDirectoryPath(input.workspaceId), { recursive: true });
	calls = [];
	gh.mockReset();
	gh.mockImplementation(runFakeGh);
	warn.mockClear();
	mocks.config.mockResolvedValue({ githubIssueSyncEnabled: true });
	mocks.board.mockClear();
	mocks.board.mockResolvedValue(board());
	mocks.history.mockResolvedValue([]);
});
afterEach(() => {
	vi.unstubAllEnvs();
	temp.cleanup();
});

describe("reconcileGithubIssues", () => {
	it("does nothing when disabled", async () => {
		mocks.config.mockResolvedValue({ githubIssueSyncEnabled: false });
		expect(await reconcile()).toEqual({ ok: true, created: 0, updated: 0, closed: 0 });
		expect(gh).not.toHaveBeenCalled();
	});
	it("creates issue for backlog task", async () => {
		await setGithubIssueSummary(input.workspaceId, "one", "Public summary");
		await reconcile();
		expect(calls).toContainEqual([
			"issue",
			"create",
			"--title",
			task.title,
			"--body",
			"Public summary\n\n---\nKanban task: one",
			"--label",
			"kanban: backlog",
		]);
		expect(JSON.stringify(calls)).not.toContain(secret);
		expect(await readGithubIssueMap(input.workspaceId)).toEqual({
			one: { ...mapped, summary: "Public summary", closed: false },
		});
	});
	it("ensures labels before first use", async () => {
		mocks.board.mockResolvedValue({
			...board(),
			columns: [{ ...board().columns[0], cards: [task, { ...task, id: "two" }] }],
		});
		await reconcile();
		expect(calls[0].slice(0, 4)).toEqual(["label", "create", "kanban: backlog", "--force"]);
		expect(calls.filter((args) => args[0] === "label")).toHaveLength(1);
		expect(calls[1]).toContain("Kanban task: one");
	});
	it("column move swaps label and comments", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("in_progress"));
		await reconcile();
		expect(calls.slice(-2)).toEqual([
			["issue", "edit", "12", "--add-label", "kanban: in progress", "--remove-label", "kanban: backlog"],
			["issue", "comment", "12", "--body", "Moved to In progress (agent: codex)"],
		]);
		expect(JSON.stringify(calls)).not.toContain(secret);
	});
	describe("column move swaps label and comments", () => {
		it.each<{ name: string; card: Partial<RuntimeBoardCard>; suffix: string }>([
			{
				name: "claude card model",
				card: { agentId: "claude", claudeModel: "sonnet" },
				suffix: " (agent: claude, model: sonnet)",
			},
			{ name: "claude default model", card: { agentId: "claude" }, suffix: " (agent: claude, model: opus)" },
			{
				name: "cline model",
				card: { agentId: "cline", clineSettings: { providerId: "openrouter", modelId: "public-model" } },
				suffix: " (agent: cline, model: public-model)",
			},
			{ name: "codex agent only", card: { agentId: "codex" }, suffix: " (agent: codex)" },
			{ name: "no agent", card: { agentId: undefined }, suffix: "" },
		])("$name", async ({ card, suffix }) => {
			await seed({ one: mapped });
			mocks.config.mockResolvedValue({ githubIssueSyncEnabled: true, claudeDefaultModel: "opus" });
			mocks.board.mockResolvedValue({
				columns: [{ id: "in_progress", title: "In progress", cards: [{ ...task, ...card }] }],
				dependencies: [],
			});
			await reconcile();
			expect(calls.at(-1)).toEqual(["issue", "comment", "12", "--body", `Moved to In progress${suffix}`]);
			expect(JSON.stringify(calls)).not.toContain(secret);
		});

		it.each<{ name: string; card: Partial<RuntimeBoardCard>; session: Record<string, unknown>; suffix: string }>([
			{
				name: "codex model and effort",
				card: {},
				session: { agentId: "codex", agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" },
				suffix: " (agent: codex, model: gpt-6.1-sol, effort: high)",
			},
			{
				name: "opencode model without effort",
				card: { agentId: "opencode" },
				session: { agentId: "opencode", agentModel: "opencode/big-pickle", agentReasoningEffort: null },
				suffix: " (agent: opencode, model: opencode/big-pickle)",
			},
			{
				name: "codex with no recorded model",
				card: {},
				session: { agentId: "codex", agentModel: null, agentReasoningEffort: null },
				suffix: " (agent: codex)",
			},
			{
				name: "session of a previous agent",
				card: { agentId: "opencode" },
				session: { agentId: "codex", agentModel: "gpt-6.1-sol", agentReasoningEffort: "high" },
				suffix: " (agent: opencode)",
			},
			{
				name: "card without an agent uses the session agent",
				card: { agentId: undefined },
				session: { agentId: "codex", agentModel: "gpt-6-luna", agentReasoningEffort: "low" },
				suffix: " (agent: codex, model: gpt-6-luna, effort: low)",
			},
			{
				name: "claude model from the session wins over the card",
				card: { agentId: "claude", claudeModel: "opus" },
				session: { agentId: "claude", claudeModel: "haiku" },
				suffix: " (agent: claude, model: haiku)",
			},
		])("session record: $name", async ({ card, session, suffix }) => {
			await seed({ one: mapped });
			vi.mocked(loadWorkspaceState).mockResolvedValueOnce({ sessions: { one: session } } as never);
			mocks.board.mockResolvedValue({
				columns: [{ id: "in_progress", title: "In progress", cards: [{ ...task, ...card }] }],
				dependencies: [],
			});
			await reconcile();
			expect(calls.at(-1)).toEqual(["issue", "comment", "12", "--body", `Moved to In progress${suffix}`]);
		});

		it("claude without a session record uses the difficulty table", async () => {
			await seed({ one: mapped });
			mocks.config.mockResolvedValue({
				githubIssueSyncEnabled: true,
				claudeDefaultModel: "opus",
				difficultyModelMap: { claude: { 3: { model: "sonnet" } } },
			});
			mocks.board.mockResolvedValue({
				columns: [
					{ id: "in_progress", title: "In progress", cards: [{ ...task, agentId: "claude", difficulty: 3 }] },
				],
				dependencies: [],
			});
			await reconcile();
			expect(calls.at(-1)).toEqual([
				"issue",
				"comment",
				"12",
				"--body",
				"Moved to In progress (agent: claude, model: sonnet)",
			]);
		});

		it("an unreadable session record does not stop the sync", async () => {
			await seed({ one: mapped });
			vi.mocked(loadWorkspaceState).mockRejectedValueOnce(new Error("sessions unreadable"));
			mocks.board.mockResolvedValue(board("in_progress"));
			expect((await reconcile()).ok).toBe(true);
			expect(calls.at(-1)).toEqual(["issue", "comment", "12", "--body", "Moved to In progress (agent: codex)"]);
		});
	});
	it("done with commit", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("trash"));
		mocks.history.mockResolvedValue([
			{ type: "pass", at: 1, commit: "old" },
			{ type: "pass", at: 3, commit: "full-sha" },
			{ type: "comment", at: 4, detail: secret },
		]);
		await reconcile();
		expect(calls).toEqual([
			["issue", "comment", "12", "--body", "Done in commit full-sha"],
			["issue", "edit", "12", "--remove-label", "kanban: backlog"],
			["issue", "close", "12", "--reason", "completed"],
		]);
		expect((await readGithubIssueMap(input.workspaceId)).one.closed).toBe(true);
	});
	it("done without commit", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(calls[0]).toEqual(["issue", "comment", "12", "--body", "Moved to Done"]);
		expect(calls.at(-1)).toEqual(["issue", "close", "12", "--reason", "completed"]);
	});
	it("task back from done reopens", async () => {
		await seed({ one: { ...mapped, syncedColumn: "trash", closed: true } });
		await reconcile();
		expect(calls).toContainEqual(["issue", "reopen", "12"]);
		expect(calls).toContainEqual(["issue", "edit", "12", "--add-label", "kanban: backlog"]);
		expect(calls.at(-1)).toEqual(["issue", "comment", "12", "--body", "Reopened, moved to Backlog"]);
	});
	it("deleted open task closes not planned", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue({ columns: [], dependencies: [] });
		await reconcile();
		expect(calls.at(-1)).toEqual(["issue", "close", "12", "--reason", "not planned"]);
		expect((await readGithubIssueMap(input.workspaceId)).one.closed).toBe(true);
	});
	it("deleted closed task", async () => {
		await seed({ one: { ...mapped, closed: true } });
		mocks.board.mockResolvedValue({ columns: [], dependencies: [] });
		await reconcile();
		expect(calls).toEqual([]);
	});
	it("backfill skips done", async () => {
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(calls).toEqual([]);
		expect((await readGithubIssueMap(input.workspaceId)).one).toEqual({ skipped: true });
		await seed({ one: { summary: "Offline task" } });
		await reconcile();
		expect(calls.some((args) => args[1] === "create" && args[0] === "issue")).toBe(true);
		expect(calls.at(-1)).toEqual(["issue", "close", "12", "--reason", "completed"]);
	});
	it("summary-only entry is ignored", async () => {
		await seed({ orphan: { summary: "unused" } });
		mocks.board.mockResolvedValue({ columns: [], dependencies: [] });
		await reconcile();
		expect(calls).toEqual([]);
		expect(await readGithubIssueMap(input.workspaceId)).toEqual({ orphan: { summary: "unused" } });
	});
	it("reconcile aborts on gh error and keeps mapping", async () => {
		await seed({ one: mapped });
		const before = await readFile(mapPath, "utf8");
		mocks.board.mockResolvedValue(board("review"));
		gh.mockRejectedValueOnce(new Error("offline"));
		expect(await reconcile()).toEqual({ ok: false, created: 0, updated: 0, closed: 0, error: "offline" });
		expect(await readFile(mapPath, "utf8")).toBe(before);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	it("passes title and body as single argv elements", async () => {
		const title = 'a "b" $(c)\nd';
		const summary = "x `y` $(z)\nq";
		mocks.board.mockResolvedValue({
			columns: [{ id: "backlog", title: "Backlog", cards: [{ ...task, title }] }],
			dependencies: [],
		});
		await setGithubIssueSummary(input.workspaceId, "one", summary);
		await reconcile();
		expect(calls.at(-1)).toEqual([
			"issue",
			"create",
			"--title",
			title,
			"--body",
			`${summary}\n\n---\nKanban task: one`,
			"--label",
			"kanban: backlog",
		]);
	});
	it("concurrent requestSync creates one issue", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		gh.mockImplementationOnce(async (args) => {
			calls.push(args);
			await gate;
			return { stdout: "" };
		});
		const service = createGithubIssueSyncService(deps);
		service.requestSync(input.workspaceId, input.repoPath);
		await vi.waitFor(() => expect(gh).toHaveBeenCalled());
		service.requestSync(input.workspaceId, input.repoPath);
		const synced = service.syncNow(input.workspaceId, input.repoPath);
		release();
		expect(await synced).toEqual({ ok: true, created: 0, updated: 0, closed: 0 });
		expect(mocks.board.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(calls.filter((args) => args[0] === "issue" && args[1] === "create")).toHaveLength(1);
	});
});

it("workspace tRPC endpoints store summaries, sync now, and return open and closed issues", async () => {
	const service = createGithubIssueSyncService(deps);
	const api = createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		githubIssueSync: service,
	});
	const scope = { workspaceId: input.workspaceId, workspacePath: input.repoPath };
	const caller = runtimeAppRouter.createCaller({
		requestedWorkspaceId: input.workspaceId,
		workspaceScope: scope,
		workspaceApi: api,
	} as RuntimeTrpcContext);
	expect(await caller.workspace.setTaskIssueSummary({ taskId: "one", summary: "UI supplied summary" })).toEqual({
		ok: true,
	});
	expect(calls).toEqual([]);
	expect(await caller.workspace.syncGithubIssues()).toEqual({ ok: true, created: 1, updated: 0, closed: 0 });
	expect(calls.find((args) => args[0] === "issue" && args[1] === "create")?.[5]).toBe(
		"UI supplied summary\n\n---\nKanban task: one",
	);
	expect(await caller.workspace.getGithubIssues()).toEqual({
		enabled: true,
		issues: { one: { number: 12, url: mapped.issueUrl } },
	});
	mocks.board.mockResolvedValue(board("trash"));
	await caller.workspace.syncGithubIssues();
	expect((await caller.workspace.getGithubIssues()).issues.one.number).toBe(12);
});

it("CLI notifyStateUpdated requests runtime sync without waiting for gh", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	gh.mockImplementationOnce(async () => {
		await gate;
		throw new Error("offline");
	});
	const service = createGithubIssueSyncService(deps);
	const hub = createRuntimeStateHub({
		onWorkspaceStateChanged: service.requestSync,
		workspaceRegistry: {
			resolveWorkspaceForStream: vi.fn(),
			buildProjectsPayload: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		},
	});
	const api = createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: hub.broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		githubIssueSync: service,
	});
	try {
		expect(await api.notifyStateUpdated({ workspaceId: input.workspaceId, workspacePath: input.repoPath })).toEqual({
			ok: true,
		});
		await vi.waitFor(() => expect(gh).toHaveBeenCalled());
		release();
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
		expect(await readGithubIssueMap(input.workspaceId)).toEqual({ one: {} });
	} finally {
		release();
		await hub.close();
	}
});

it("offline-created task still creates and closes an issue after moving to done", async () => {
	gh.mockRejectedValueOnce(new Error("offline"));
	expect((await reconcile()).ok).toBe(false);
	expect(await readGithubIssueMap(input.workspaceId)).toEqual({ one: {} });
	mocks.board.mockResolvedValue(board("trash"));
	expect(await reconcile()).toEqual({ ok: true, created: 1, updated: 0, closed: 1 });
});

it("failure after creation keeps the issue id and retries without duplicate creation", async () => {
	await seed({ one: { summary: "offline" } });
	mocks.board.mockResolvedValue(board("trash"));
	gh.mockImplementationOnce(async (args) => {
		calls.push(args);
		return { stdout: mapped.issueUrl };
	});
	gh.mockRejectedValueOnce(new Error("comment failed"));
	expect((await reconcile()).ok).toBe(false);
	expect((await readGithubIssueMap(input.workspaceId)).one.issueNumber).toBe(12);
	await reconcile();
	expect(calls.filter((args) => args[0] === "issue" && args[1] === "create")).toHaveLength(1);
});

it("concurrent independent reconcilers create one issue under the mapping lock", async () => {
	await Promise.all([reconcile(), reconcile()]);
	expect(calls.filter((args) => args[0] === "issue" && args[1] === "create")).toHaveLength(1);
});

it("board writes succeed while gh is failing", async () => {
	const repoPath = join(temp.path, "repo");
	await mkdir(repoPath);
	execFileSync("git", ["init", repoPath], { env: createGitTestEnv(), stdio: "ignore" });
	const initial = await loadWorkspaceState(repoPath);
	const scope = { workspaceId: (await loadWorkspaceContext(repoPath)).workspaceId, workspacePath: repoPath };
	const issuePath = join(getWorkspaceDirectoryPath(scope.workspaceId), "github-issues.json");
	await mkdir(getWorkspaceDirectoryPath(scope.workspaceId), { recursive: true });
	await writeFile(issuePath, JSON.stringify({ one: mapped }));
	const before = await readFile(issuePath, "utf8");
	mocks.board.mockResolvedValue(board("review"));
	gh.mockRejectedValue(new Error("gh unavailable"));
	const service = createGithubIssueSyncService(deps);
	const hub = createRuntimeStateHub({
		onWorkspaceStateChanged: service.requestSync,
		workspaceRegistry: {
			resolveWorkspaceForStream: vi.fn(),
			buildProjectsPayload: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		},
	});
	const manager = { listSummaries: () => [] } as unknown as TerminalSessionManager;
	const api = createWorkspaceApi({
		ensureTerminalManagerForWorkspace: async () => manager,
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: hub.broadcastRuntimeWorkspaceStateUpdated,
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
		githubIssueSync: service,
	});
	try {
		const saved = await api.saveState(scope, { board: board("review"), sessions: {} });
		expect(saved.revision).toBe(initial.revision + 1);
		expect((await service.syncNow(scope.workspaceId, repoPath)).ok).toBe(false);
		expect(
			(await loadWorkspaceState(repoPath)).board.columns.find((column) => column.id === "review")?.cards[0].id,
		).toBe("one");
		expect(await readFile(issuePath, "utf8")).toBe(before);
	} finally {
		await hub.close();
	}
});

it("remembers every open task before aborting on the first gh error", async () => {
	mocks.board.mockResolvedValue({
		columns: [{ id: "backlog", title: "Backlog", cards: [task, { ...task, id: "two" }] }],
		dependencies: [],
	});
	gh.mockRejectedValueOnce(new Error("offline"));
	await reconcile();
	expect(await readGithubIssueMap(input.workspaceId)).toEqual({ one: {}, two: {} });
	mocks.board.mockResolvedValue({
		columns: [{ id: "trash", title: "Done", cards: [{ ...task, id: "two" }] }],
		dependencies: [],
	});
	expect(await reconcile()).toEqual({ ok: true, created: 1, updated: 0, closed: 1 });
	expect((await readGithubIssueMap(input.workspaceId)).two.closed).toBe(true);
});
