import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeTaskSessionSummary } from "../../../src/core/api-contract";
import { buildShellCommandLine } from "../../../src/core/shell";
import { PtySession, type SpawnPtySessionRequest } from "../../../src/terminal/pty-session";
import { TerminalSessionManager } from "../../../src/terminal/session-manager";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "running",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...overrides,
	};
}

describe("TerminalSessionManager", () => {
	it("records the Claude model that was actually launched", async () => {
		const spawnRequests: SpawnPtySessionRequest[] = [];
		const spawn = vi.spyOn(PtySession, "spawn").mockImplementation((request) => {
			spawnRequests.push(request);
			return {
				pid: spawnRequests.length,
				stop: vi.fn(),
				write: vi.fn(),
				wasInterrupted: () => false,
			} as unknown as PtySession;
		});
		try {
			const manager = new TerminalSessionManager();
			await manager.startTaskSession({
				taskId: "claude-default-model",
				agentId: "claude",
				binary: "claude",
				args: [],
				claudeModel: "opus",
				cwd: "/tmp/worktree",
				prompt: "",
			});
			expect(spawnRequests[0]?.args).toContain("--model");
			expect(spawnRequests[0]?.args).toContain("opus");
			expect(manager.getSummary("claude-default-model")?.claudeModel).toBe("opus");

			await manager.startTaskSession({
				taskId: "claude-custom-model",
				agentId: "claude",
				binary: "claude",
				args: ["--model", "custom-x"],
				claudeModel: "haiku",
				cwd: "/tmp/worktree",
				prompt: "",
			});
			const customModelArgs = spawnRequests[1]?.args;
			expect(Array.isArray(customModelArgs) ? customModelArgs.filter((arg) => arg === "--model") : []).toHaveLength(
				1,
			);
			expect(manager.getSummary("claude-custom-model")?.claudeModel).toBeNull();

			await manager.startTaskSession({
				taskId: "claude-explicit-model",
				agentId: "claude",
				binary: "claude",
				args: ["--model=sonnet"],
				cwd: "/tmp/worktree",
				prompt: "",
			});
			expect(manager.getSummary("claude-explicit-model")?.claudeModel).toBe("sonnet");

			await manager.startTaskSession({
				taskId: "__home_agent__:workspace-1:claude",
				agentId: "claude",
				binary: "claude",
				args: [],
				claudeModel: "opus",
				cwd: "/tmp/worktree",
				prompt: "",
			});
			const homeArgs = spawnRequests[3]?.args;
			expect(homeArgs).not.toContain("--model");
			expect(manager.getSummary("__home_agent__:workspace-1:claude")?.claudeModel).toBeNull();
		} finally {
			spawn.mockRestore();
		}
	});

	it("records the Codex and OpenCode model that was actually launched", async () => {
		// The OpenCode adapter writes its config under the runtime home; never touch the real one.
		const tempHome = mkdtempSync(join(tmpdir(), "kanban-session-manager-"));
		vi.stubEnv("HOME", tempHome);
		const spawnRequests: SpawnPtySessionRequest[] = [];
		const spawn = vi.spyOn(PtySession, "spawn").mockImplementation((request) => {
			spawnRequests.push(request);
			return {
				pid: spawnRequests.length,
				stop: vi.fn(),
				write: vi.fn(),
				wasInterrupted: () => false,
			} as unknown as PtySession;
		});
		try {
			const manager = new TerminalSessionManager();
			const base = { binary: "agent", args: [], cwd: "/tmp/worktree", prompt: "" };
			await manager.startTaskSession({
				...base,
				taskId: "codex-model",
				agentId: "codex",
				agentModel: "gpt-6.1-sol",
				agentReasoningEffort: "high",
			});
			expect(spawnRequests[0]?.args).toContain("gpt-6.1-sol");
			expect(manager.getSummary("codex-model")).toMatchObject({
				agentModel: "gpt-6.1-sol",
				agentReasoningEffort: "high",
				claudeModel: null,
			});

			await manager.startTaskSession({ ...base, taskId: "codex-default", agentId: "codex" });
			expect(manager.getSummary("codex-default")).toMatchObject({ agentModel: null, agentReasoningEffort: null });

			await manager.startTaskSession({
				...base,
				taskId: "codex-user-args",
				agentId: "codex",
				args: ["-m", "user-model"],
				agentModel: "gpt-6.1-sol",
			});
			expect(manager.getSummary("codex-user-args")?.agentModel).toBe("user-model");

			await manager.startTaskSession({
				...base,
				taskId: "opencode-model",
				agentId: "opencode",
				agentModel: "opencode/free-1",
			});
			expect(manager.getSummary("opencode-model")).toMatchObject({
				agentModel: "opencode/free-1",
				agentReasoningEffort: null,
			});
			manager.stopTaskSession("opencode-model");

			await manager.startTaskSession({
				...base,
				taskId: "claude-model",
				agentId: "claude",
				claudeModel: "opus",
			});
			expect(manager.getSummary("claude-model")).toMatchObject({ claudeModel: "opus", agentModel: null });
			const taskConfigDirectory = join(tempHome, ".cline", "kanban", "hooks", "opencode", "tasks");
			expect(existsSync(taskConfigDirectory)).toBe(true);
			expect(readdirSync(taskConfigDirectory).length).toBeLessThanOrEqual(1);
		} finally {
			spawn.mockRestore();
			vi.unstubAllEnvs();
			rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("defaults the PTY locale to UTF-8 only when no locale is configured", async () => {
		vi.stubEnv("LANG", undefined);
		vi.stubEnv("LC_ALL", undefined);
		vi.stubEnv("LC_CTYPE", undefined);
		const spawn = vi.spyOn(PtySession, "spawn").mockImplementation(
			() =>
				({
					pid: 1234,
					stop: vi.fn(),
					write: vi.fn(),
					wasInterrupted: () => false,
				}) as unknown as PtySession,
		);
		try {
			await new TerminalSessionManager().startShellSession({ taskId: "locale", cwd: "/tmp", binary: "sh" });
			expect(spawn.mock.calls[0]?.[0].env).toMatchObject({ LANG: "en_US.UTF-8" });
		} finally {
			spawn.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it("keeps a locale supplied by the process or session request", async () => {
		vi.stubEnv("LANG", "fr_FR.UTF-8");
		vi.stubEnv("LC_ALL", undefined);
		vi.stubEnv("LC_CTYPE", undefined);
		const spawn = vi.spyOn(PtySession, "spawn").mockImplementation(
			() =>
				({
					pid: 1234,
					stop: vi.fn(),
					write: vi.fn(),
					wasInterrupted: () => false,
				}) as unknown as PtySession,
		);
		try {
			await new TerminalSessionManager().startShellSession({ taskId: "locale", cwd: "/tmp", binary: "sh" });
			expect(spawn.mock.calls[0]?.[0].env).toMatchObject({ LANG: "fr_FR.UTF-8" });
			await new TerminalSessionManager().startShellSession({
				taskId: "request-locale",
				cwd: "/tmp",
				binary: "sh",
				env: { LANG: "de_DE.UTF-8" },
			});
			expect(spawn.mock.calls[1]?.[0].env).toMatchObject({ LANG: "de_DE.UTF-8" });
			vi.stubEnv("LANG", undefined);
			vi.stubEnv("LC_ALL", "fr_FR.UTF-8");
			await new TerminalSessionManager().startShellSession({ taskId: "lc-all", cwd: "/tmp", binary: "sh" });
			expect(spawn.mock.calls[2]?.[0].env).toMatchObject({ LC_ALL: "fr_FR.UTF-8" });
			expect(spawn.mock.calls[2]?.[0].env?.LANG).toBeUndefined();
			vi.stubEnv("LC_ALL", undefined);
			await new TerminalSessionManager().startShellSession({
				taskId: "lc-ctype",
				cwd: "/tmp",
				binary: "sh",
				env: { LC_CTYPE: "fr_FR.UTF-8" },
			});
			expect(spawn.mock.calls[3]?.[0].env).toMatchObject({ LC_CTYPE: "fr_FR.UTF-8" });
			expect(spawn.mock.calls[3]?.[0].env?.LANG).toBeUndefined();
		} finally {
			spawn.mockRestore();
			vi.unstubAllEnvs();
		}
	});

	it("replaces a stopped awaiting-review session and ignores its late exit", async () => {
		const spawnRequests: SpawnPtySessionRequest[] = [];
		const stop = vi.fn();
		const spawn = vi.spyOn(PtySession, "spawn").mockImplementation((request) => {
			spawnRequests.push(request);
			return {
				pid: spawnRequests.length,
				stop,
				write: vi.fn(),
				wasInterrupted: () => false,
			} as unknown as PtySession;
		});
		try {
			const manager = new TerminalSessionManager();
			const start = (agentId: "antigravity" | "codex") =>
				manager.startTaskSession({
					taskId: "task-1",
					agentId,
					binary: agentId,
					args: [],
					cwd: "/tmp/worktree",
					prompt: "Continue the task",
				});

			await start("antigravity");
			manager.transitionToReview("task-1", "hook");
			manager.stopTaskSession("task-1");
			await start("codex");

			expect(spawn).toHaveBeenCalledTimes(2);
			expect(spawnRequests[1]).toMatchObject({ binary: "codex", cwd: "/tmp/worktree" });
			expect(manager.getSummary("task-1")).toMatchObject({ agentId: "codex", state: "running" });

			spawnRequests[0]?.onExit?.({ exitCode: 0 });
			expect(manager.getSummary("task-1")).toMatchObject({ agentId: "codex", state: "running" });
		} finally {
			spawn.mockRestore();
		}
	});

	it("clears trust prompt state when transitioning to review", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ state: "running", reviewReason: null }),
			active: {
				workspaceTrustBuffer: "trust this folder",
				awaitingCodexPromptAfterEnter: true,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		const applySessionEvent = (
			manager as unknown as {
				applySessionEvent: (sessionEntry: unknown, event: { type: "hook.to_review" }) => RuntimeTaskSessionSummary;
			}
		).applySessionEvent;
		const nextSummary = applySessionEvent(entry, { type: "hook.to_review" });
		expect(nextSummary.state).toBe("awaiting_review");
		expect(entry.active.workspaceTrustBuffer).toBe("");
	});

	it("builds shell kickoff command lines with quoted arguments", () => {
		const commandLine = buildShellCommandLine("cline", ["--auto-approve-all", "hello world"]);
		expect(commandLine).toContain("cline");
		expect(commandLine).toContain("--auto-approve-all");
		expect(commandLine).toContain("hello world");
	});

	it("stores hook activity metadata on sessions", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const updated = manager.applyHookActivity("task-1", {
			source: "claude",
			activityText: "Using Read",
			toolName: "Read",
		});

		expect(updated?.latestHookActivity?.source).toBe("claude");
		expect(updated?.latestHookActivity?.activityText).toBe("Using Read");
		expect(updated?.latestHookActivity?.toolName).toBe("Read");
		expect(typeof updated?.lastHookAt).toBe("number");
	});

	it("resets stale running sessions without active processes", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		const recovered = manager.recoverStaleSession("task-1");

		expect(recovered?.state).toBe("idle");
		expect(recovered?.pid).toBeNull();
		expect(recovered?.agentId).toBe("claude");
		expect(recovered?.workspacePath).toBeNull();
		expect(recovered?.reviewReason).toBeNull();
	});

	it("tracks only the latest two turn checkpoints", () => {
		const manager = new TerminalSessionManager();
		manager.hydrateFromRecord({
			"task-1": createSummary({ state: "running" }),
		});

		manager.applyTurnCheckpoint("task-1", {
			turn: 1,
			ref: "refs/kanban/checkpoints/task-1/turn/1",
			commit: "1111111",
			createdAt: 1,
		});
		manager.applyTurnCheckpoint("task-1", {
			turn: 2,
			ref: "refs/kanban/checkpoints/task-1/turn/2",
			commit: "2222222",
			createdAt: 2,
		});

		const summary = manager.getSummary("task-1");
		expect(summary?.latestTurnCheckpoint?.turn).toBe(2);
		expect(summary?.previousTurnCheckpoint?.turn).toBe(1);
	});

	it("does not replay raw PTY history when attaching an output listener", () => {
		const manager = new TerminalSessionManager();
		const onOutput = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-probe", state: "running" }),
			active: {
				session: {},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-probe", entry);

		manager.attach("task-probe", {
			onOutput,
		});

		expect(onOutput).not.toHaveBeenCalled();
		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(false);
	});

	it("keeps the startup probe filter enabled when only a non-output listener attaches", () => {
		const manager = new TerminalSessionManager();
		const entry = {
			summary: createSummary({ taskId: "task-control-first", state: "running" }),
			active: {
				session: {
					write: vi.fn(),
				},
				terminalProtocolFilter: {
					pendingChunk: null,
					interceptOscColorQueries: true,
					suppressDeviceAttributeQueries: false,
				},
			},
			terminalStateMirror: null,
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-control-first", entry);

		manager.attach("task-control-first", {
			onState: vi.fn(),
			onExit: vi.fn(),
		});

		expect(entry.active.terminalProtocolFilter.interceptOscColorQueries).toBe(true);
		expect(entry.active.terminalProtocolFilter.pendingChunk).toBeNull();
	});

	it("forwards pixel dimensions through resize when provided", () => {
		const manager = new TerminalSessionManager();
		const resizeSpy = vi.fn();
		const resizeMirrorSpy = vi.fn();
		const entry = {
			summary: createSummary({ taskId: "task-resize", state: "running" }),
			active: {
				session: {
					resize: resizeSpy,
				},
				cols: 80,
				rows: 24,
			},
			terminalStateMirror: {
				resize: resizeMirrorSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-resize", entry);

		const resized = manager.resize("task-resize", 100, 30, 1200, 720);
		expect(resized).toBe(true);
		expect(resizeSpy).toHaveBeenCalledWith(100, 30, 1200, 720);
		expect(resizeMirrorSpy).toHaveBeenCalledWith(100, 30);
	});

	it("returns the latest terminal restore snapshot when available", async () => {
		const manager = new TerminalSessionManager();
		const getSnapshotSpy = vi.fn(async () => ({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		}));
		const entry = {
			summary: createSummary({ taskId: "task-restore", state: "running" }),
			active: null,
			terminalStateMirror: {
				getSnapshot: getSnapshotSpy,
			},
			listenerIdCounter: 1,
			listeners: new Map(),
		};
		(
			manager as unknown as {
				entries: Map<string, typeof entry>;
			}
		).entries.set("task-restore", entry);

		const snapshot = await manager.getRestoreSnapshot("task-restore");

		expect(snapshot).toEqual({
			snapshot: "serialized terminal",
			cols: 120,
			rows: 40,
		});
		expect(getSnapshotSpy).toHaveBeenCalledTimes(1);
	});
});
