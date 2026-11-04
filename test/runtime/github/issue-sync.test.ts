import { execFileSync } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../../../src/core/api-contract";
import { getOriginRemoteUrl } from "../../../src/github/gh-runner";
import { type GithubIssueMap, readGithubIssueMap, setGithubIssueSummary } from "../../../src/github/issue-map";
import { hashReport, ISSUE_REPORT_FILE } from "../../../src/github/issue-report";
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
import type * as TaskWorktreeModule from "../../../src/workspace/task-worktree";
import { resolveTaskCwd } from "../../../src/workspace/task-worktree";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const mocks = vi.hoisted(() => ({ config: vi.fn(), board: vi.fn(), history: vi.fn(), reportDir: "" }));
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
vi.mock("../../../src/workspace/task-worktree", async (original) => ({
	...(await original<typeof TaskWorktreeModule>()),
	resolveTaskCwd: vi.fn(async () => mocks.reportDir),
}));
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
let rawCalls: string[][];
let expectedRepo = "own/project";
let mapPath: string;
const warn = vi.fn();
const runFakeGh = async (args: string[], options: { cwd: string }) => {
	expect(options.cwd).toBe(input.repoPath);
	expect(args.slice(-2)).toEqual(["--repo", expectedRepo]);
	rawCalls.push(args);
	calls.push(args.filter((arg, index) => !(arg === "--repo" || args[index - 1] === "--repo")));
	return { stdout: args[0] === "issue" && args[1] === "create" ? "https://github.com/o/r/issues/12\n" : "" };
};
const gh = vi.fn(runFakeGh);
const deps = { runGh: gh, getOriginRemoteUrl: async () => "git@github.com:own/project.git", warn };
function board(column: RuntimeBoardColumnId = "backlog"): RuntimeBoardData {
	return { columns: [{ id: column, title: column, cards: [task] }], dependencies: [] };
}
async function seed(map: GithubIssueMap) {
	await writeFile(mapPath, JSON.stringify(map));
}
const mapped = {
	issueNumber: 12,
	issueUrl: "https://github.com/o/r/issues/12",
	syncedColumn: "backlog" as const,
	syncedTitle: "Public title",
};
const reconcile = () => reconcileGithubIssues(input, deps);
beforeEach(async () => {
	temp = createTempDir("github-sync-");
	vi.stubEnv("HOME", temp.path);
	vi.stubEnv("USERPROFILE", temp.path);
	mapPath = join(getWorkspaceDirectoryPath(input.workspaceId), "github-issues.json");
	await mkdir(getWorkspaceDirectoryPath(input.workspaceId), { recursive: true });
	calls = [];
	rawCalls = [];
	expectedRepo = "own/project";
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
	it("resolves origin when upstream is also configured", async () => {
		const repoPath = join(temp.path, "repo-with-remotes");
		await mkdir(repoPath);
		execFileSync("git", ["init", repoPath], { env: createGitTestEnv(), stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:own/project.git"], {
			cwd: repoPath,
			env: createGitTestEnv(),
		});
		execFileSync("git", ["remote", "add", "upstream", "git@github.com:cline/kanban.git"], {
			cwd: repoPath,
			env: createGitTestEnv(),
		});
		expect(await getOriginRemoteUrl(repoPath)).toBe("git@github.com:own/project.git");
	});

	it("does nothing when disabled", async () => {
		mocks.config.mockResolvedValue({ githubIssueSyncEnabled: false });
		expect(await reconcile()).toEqual({ ok: true, created: 0, updated: 0, closed: 0 });
		expect(gh).not.toHaveBeenCalled();
	});
	it("targets origin on every gh call, accepts GitHub origin URL forms, and rejects an invalid origin", async () => {
		await reconcile();
		await seed({ one: { ...mapped, closed: true, syncedColumn: "trash" } });
		await reconcile();
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(rawCalls.map((args) => args.slice(0, 2))).toEqual(
			expect.arrayContaining([
				["label", "create"],
				["issue", "create"],
				["issue", "reopen"],
				["issue", "close"],
			]),
		);
		for (const origin of ["ssh://git@github.com/o/r.git", "https://github.com/o/r/"]) {
			expectedRepo = "o/r";
			const withSupportedOrigin = await reconcileGithubIssues(input, {
				...deps,
				getOriginRemoteUrl: async () => origin,
			});
			expect(withSupportedOrigin.ok).toBe(true);
		}
		expectedRepo = "own/project";
		gh.mockClear();
		const noOrigin = await reconcileGithubIssues(input, {
			...deps,
			getOriginRemoteUrl: async () => {
				throw new Error("missing");
			},
		});
		expect(noOrigin).toMatchObject({ ok: false, error: expect.stringContaining("origin remote") });
		expect(gh).not.toHaveBeenCalled();
		const invalid = await reconcileGithubIssues(input, {
			...deps,
			getOriginRemoteUrl: async () => "https://example.com/o/r",
		});
		expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining("parse") });
		expect(gh).not.toHaveBeenCalled();
	});
	it("edits a changed summary once and retries a failed edit", async () => {
		await seed({ one: { ...mapped, summary: "old", syncedSummary: "old" } });
		await setGithubIssueSummary(input.workspaceId, "one", "new summary");
		gh.mockRejectedValueOnce(new Error("edit failed"));
		expect((await reconcile()).ok).toBe(false);
		expect((await readGithubIssueMap(input.workspaceId)).one.syncedSummary).toBe("old");
		await reconcile();
		expect(calls).toContainEqual(["issue", "edit", "12", "--body", "new summary\n\n---\nKanban task: one"]);
		expect((await readGithubIssueMap(input.workspaceId)).one.syncedSummary).toBe("new summary");
		const length = rawCalls.length;
		await reconcile();
		expect(rawCalls.length).toBe(length);
	});
	it("edits a changed summary on a closed issue without reopening it", async () => {
		await seed({ one: { ...mapped, closed: true, syncedColumn: "trash", summary: "old", syncedSummary: "old" } });
		await setGithubIssueSummary(input.workspaceId, "one", "new summary");
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(calls).toContainEqual(["issue", "edit", "12", "--body", "new summary\n\n---\nKanban task: one"]);
		expect(calls.filter((args) => args[1] === "edit" && args.includes("--body"))).toHaveLength(1);
		expect(calls.some((args) => args[1] === "reopen")).toBe(false);
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
			one: {
				...mapped,
				summary: "Public summary",
				syncedSummary: "Public summary",
				syncedTitle: task.title,
				closed: false,
			},
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
			["issue", "comment", "12", "--body", "**Agent:** codex\n**Status:** In progress\n\n<!-- kanban-sync -->"],
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
			{ name: "no agent", card: { agentId: undefined }, suffix: "unknown" },
		])("$name", async ({ card, suffix }) => {
			await seed({ one: mapped });
			mocks.config.mockResolvedValue({ githubIssueSyncEnabled: true, claudeDefaultModel: "opus" });
			mocks.board.mockResolvedValue({
				columns: [{ id: "in_progress", title: "In progress", cards: [{ ...task, ...card }] }],
				dependencies: [],
			});
			await reconcile();
			expect(calls.at(-1)).toEqual([
				"issue",
				"comment",
				"12",
				"--body",
				`**Agent:** ${suffix.replace(" (agent: ", "").replace(")", "")}
**Status:** In progress

<!-- kanban-sync -->`,
			]);
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
			expect(calls.at(-1)).toEqual([
				"issue",
				"comment",
				"12",
				"--body",
				`**Agent:** ${suffix.replace(" (agent: ", "").replace(")", "")}
**Status:** In progress

<!-- kanban-sync -->`,
			]);
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
				"**Agent:** claude, model: sonnet\n**Status:** In progress\n\n<!-- kanban-sync -->",
			]);
		});

		it("an unreadable session record does not stop the sync", async () => {
			await seed({ one: mapped });
			vi.mocked(loadWorkspaceState).mockRejectedValueOnce(new Error("sessions unreadable"));
			mocks.board.mockResolvedValue(board("in_progress"));
			expect((await reconcile()).ok).toBe(true);
			expect(calls.at(-1)).toEqual([
				"issue",
				"comment",
				"12",
				"--body",
				"**Agent:** codex\n**Status:** In progress\n\n<!-- kanban-sync -->",
			]);
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
			["issue", "comment", "12", "--body", "**Status:** Done\n**Commit:** full-sha\n\n<!-- kanban-sync -->"],
			["issue", "edit", "12", "--remove-label", "kanban: backlog"],
			["issue", "close", "12", "--reason", "completed"],
		]);
		expect((await readGithubIssueMap(input.workspaceId)).one.closed).toBe(true);
	});
	it("done without commit", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(calls[0]).toEqual(["issue", "comment", "12", "--body", "**Status:** Done\n\n<!-- kanban-sync -->"]);
		expect(calls.at(-1)).toEqual(["issue", "close", "12", "--reason", "completed"]);
	});
	it("task back from done reopens", async () => {
		await seed({ one: { ...mapped, syncedColumn: "trash", closed: true } });
		await reconcile();
		expect(calls).toContainEqual(["issue", "reopen", "12"]);
		expect(calls).toContainEqual(["issue", "edit", "12", "--add-label", "kanban: backlog"]);
		expect(calls.at(-1)).toEqual([
			"issue",
			"comment",
			"12",
			"--body",
			"**Agent:** codex\n**Status:** Reopened, moved to Backlog\n\n<!-- kanban-sync -->",
		]);
	});
	it("posts a second Done comment after a task is reopened", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		mocks.board.mockResolvedValue(board("backlog"));
		await reconcile();
		mocks.board.mockResolvedValue(board("trash"));
		await reconcile();
		expect(
			calls.filter((args) => args[0] === "issue" && args[1] === "comment" && args[4]?.includes("**Status:** Done")),
		).toHaveLength(2);
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
		mocks.board.mockResolvedValue(board("in_progress"));
		gh.mockRejectedValueOnce(new Error("offline"));
		expect(await reconcile()).toEqual({ ok: false, created: 0, updated: 0, closed: 0, error: "offline" });
		expect((await readGithubIssueMap(input.workspaceId)).one.lastError).toBe("offline");
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
	it("posts a Review report once, saves its hash, and deletes the file", async () => {
		mocks.reportDir = join(temp.path, "report-worktree");
		await mkdir(mocks.reportDir);
		const report =
			"### Summary\nDone\n\n### Changes\nCode\n\n### Tests\nPassed\n\n### References\nNone\n\n### Next Steps\nNone";
		await writeFile(join(mocks.reportDir, ISSUE_REPORT_FILE), report);
		await seed({ one: { ...mapped, syncedColumn: "review" } });
		mocks.board.mockResolvedValue(board("review"));
		await reconcile();
		expect(calls.filter((args) => args[1] === "comment")).toHaveLength(1);
		expect(calls.find((args) => args[1] === "comment")?.[4]).toContain("## Implementation Update");
		expect(calls.find((args) => args[1] === "comment")?.[4]).toContain("**Base:** main");
		expect((await readGithubIssueMap(input.workspaceId)).one.reportHash).toBe(hashReport(report));
		await expect(access(join(mocks.reportDir, ISSUE_REPORT_FILE))).rejects.toThrow();
		const count = calls.length;
		await reconcile();
		expect(calls).toHaveLength(count);
	});
	it("keeps Done comment recorded when close fails, then retries only close", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue(board("trash"));
		gh.mockImplementationOnce(runFakeGh)
			.mockImplementationOnce(runFakeGh)
			.mockRejectedValueOnce(new Error("close failed"));
		expect((await reconcile()).ok).toBe(false);
		expect((await readGithubIssueMap(input.workspaceId)).one.doneCommented).toBe(true);
		const before = calls.filter((args) => args[1] === "comment").length;
		const callsBeforeRetry = calls.length;
		await reconcile();
		expect(calls.filter((args) => args[1] === "comment")).toHaveLength(before);
		expect(calls.slice(callsBeforeRetry)).toEqual([["issue", "close", "12", "--reason", "completed"]]);
	});
	it("sanitizes internal paths from GitHub titles and bodies", async () => {
		await setGithubIssueSummary(input.workspaceId, "one", "See contexte/x.md and /Users/a/b; docs/a.md is public");
		mocks.board.mockResolvedValue({
			columns: [{ id: "backlog", title: "Local /Users/a/b", cards: [{ ...task, title: "Local /Users/a/b" }] }],
			dependencies: [],
		});
		await reconcile();
		expect(JSON.stringify(calls)).not.toContain("/Users/");
		expect(JSON.stringify(calls)).not.toContain("contexte/");
		expect(JSON.stringify(calls)).toContain("[internal path]");
		expect(JSON.stringify(calls)).toContain("docs/a.md");
	});
	it("syncs card title changes and broadcasts map changes", async () => {
		await seed({ one: mapped });
		mocks.board.mockResolvedValue({
			...board(),
			columns: [{ id: "backlog", title: "Backlog", cards: [{ ...task, title: "Changed title" }] }],
		});
		const broadcast = vi.fn();
		expect(
			(await reconcileGithubIssues(input, { ...deps, broadcastRuntimeWorkspaceStateUpdated: broadcast })).ok,
		).toBe(true);
		expect(calls).toContainEqual(["issue", "edit", "12", "--title", "Changed title"]);
		expect((await readGithubIssueMap(input.workspaceId)).one.syncedTitle).toBe("Changed title");
		expect(broadcast).toHaveBeenCalledOnce();
	});
	it("isolates a task failure and syncs the next task", async () => {
		const second = { ...task, id: "two", title: "Second" };
		mocks.board.mockResolvedValue({
			columns: [{ id: "in_progress", title: "In progress", cards: [task, second] }],
			dependencies: [],
		});
		await seed({
			one: mapped,
			two: { ...mapped, issueNumber: 13, issueUrl: "https://github.com/o/r/issues/13", syncedTitle: "Second" },
		});
		gh.mockImplementation(async (args, options) => {
			if (args.includes("12") && args.includes("--add-label")) throw new Error("first failed");
			return runFakeGh(args, options);
		});
		const result = await reconcile();
		expect(result.ok).toBe(false);
		expect(result.error).toBe("first failed");
		expect((await readGithubIssueMap(input.workspaceId)).one.lastError).toBe("first failed");
		expect(calls.some((args) => args.includes("13") && args[1] === "comment")).toBe(true);
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
	const requestSync = vi.spyOn(service, "requestSync");
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
	expect(requestSync).toHaveBeenCalledWith(input.workspaceId, input.repoPath);
	await vi.waitFor(async () => expect((await readGithubIssueMap(input.workspaceId)).one.issueNumber).toBe(12));
	expect(await caller.workspace.syncGithubIssues()).toEqual({ ok: true, created: 0, updated: 0, closed: 0 });
	expect(calls.find((args) => args[0] === "issue" && args[1] === "create")?.[5]).toBe(
		"UI supplied summary\n\n---\nKanban task: one",
	);
	expect(await caller.workspace.getGithubIssues()).toEqual({
		enabled: true,
		issues: { one: { number: 12, url: mapped.issueUrl } },
		reports: { one: "none" },
	});
	mocks.board.mockResolvedValue(board("trash"));
	await caller.workspace.syncGithubIssues();
	expect((await caller.workspace.getGithubIssues()).issues.one.number).toBe(12);
});

it("getGithubIssues skips report worktree lookups when sync is off", async () => {
	mocks.config.mockResolvedValue({ githubIssueSyncEnabled: false });
	const api = createWorkspaceApi({
		ensureTerminalManagerForWorkspace: vi.fn(),
		getScopedClineTaskSessionService: vi.fn(),
		broadcastRuntimeWorkspaceStateUpdated: vi.fn(),
		broadcastRuntimeProjectsUpdated: vi.fn(),
		buildWorkspaceStateSnapshot: vi.fn(),
	});
	vi.mocked(resolveTaskCwd).mockClear();
	const scope = { workspaceId: input.workspaceId, workspacePath: input.repoPath };
	const caller = runtimeAppRouter.createCaller({
		requestedWorkspaceId: input.workspaceId,
		workspaceScope: scope,
		workspaceApi: api,
	} as RuntimeTrpcContext);
	expect(await caller.workspace.getGithubIssues()).toEqual({ enabled: false, issues: {}, reports: {} });
	expect(resolveTaskCwd).not.toHaveBeenCalled();
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
		expect((await readGithubIssueMap(input.workspaceId)).one).toMatchObject({ lastError: "offline" });
	} finally {
		release();
		await hub.close();
	}
});

it("offline-created task still creates and closes an issue after moving to done", async () => {
	gh.mockRejectedValueOnce(new Error("offline"));
	expect((await reconcile()).ok).toBe(false);
	expect((await readGithubIssueMap(input.workspaceId)).one).toMatchObject({ lastError: "offline" });
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
		broadcastRuntimeWorkspaceStateUpdated: hub.broadcastRuntimeWorkspaceStateUpdatedToClients,
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
		expect((await readGithubIssueMap(scope.workspaceId)).one.lastError).toBe("gh unavailable");
	} finally {
		await hub.close();
	}
});

it("does not resync after a failed reconcile broadcasts to runtime clients", async () => {
	await seed({ one: mapped });
	mocks.board.mockResolvedValue(board("review"));
	gh.mockRejectedValue(new Error("offline"));
	let requestSync: (workspaceId: string, repoPath: string) => void = () => {};
	const hub = createRuntimeStateHub({
		onWorkspaceStateChanged: (workspaceId, repoPath) => requestSync(workspaceId, repoPath),
		workspaceRegistry: {
			resolveWorkspaceForStream: vi.fn(),
			buildProjectsPayload: vi.fn(),
			buildWorkspaceStateSnapshot: vi.fn(),
		},
	});
	const broadcast = vi.fn((workspaceId: string, repoPath: string) =>
		hub.broadcastRuntimeWorkspaceStateUpdatedToClients(workspaceId, repoPath),
	);
	const sync = createGithubIssueSyncService({ ...deps, broadcastRuntimeWorkspaceStateUpdated: broadcast });
	requestSync = sync.requestSync;
	try {
		sync.requestSync(input.workspaceId, input.repoPath);
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(mocks.board).toHaveBeenCalledTimes(1);
		expect(gh).toHaveBeenCalledTimes(1);
		expect(broadcast).not.toHaveBeenCalled();
		expect((await readGithubIssueMap(input.workspaceId)).one.lastError).toBe("offline");
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
	expect((await readGithubIssueMap(input.workspaceId)).one.lastError).toBe("offline");
	expect((await readGithubIssueMap(input.workspaceId)).two.issueNumber).toBe(12);
	mocks.board.mockResolvedValue({
		columns: [{ id: "trash", title: "Done", cards: [{ ...task, id: "two" }] }],
		dependencies: [],
	});
	expect(await reconcile()).toEqual({ ok: true, created: 0, updated: 0, closed: 1 });
	expect((await readGithubIssueMap(input.workspaceId)).two.closed).toBe(true);
});
