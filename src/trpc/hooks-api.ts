import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
	RuntimeHookEvent,
	RuntimeHookIngestResponse,
	RuntimeTaskHookActivity,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { parseHookIngestRequest } from "../core/api-validation";
import { recordTaskHistoryEvent, type TaskHistoryEvent } from "../state/task-history";
import { loadWorkspaceContextById } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import type { RuntimeTrpcContext } from "./app-router";

export interface CreateHooksApiDependencies {
	getWorkspacePathById: (workspaceId: string) => string | null;
	ensureTerminalManagerForWorkspace: (workspaceId: string, repoPath: string) => Promise<TerminalSessionManager>;
	broadcastRuntimeWorkspaceStateUpdated: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	broadcastTaskReadyForReview: (workspaceId: string, taskId: string) => void;
	captureTaskTurnCheckpoint?: (input: {
		cwd: string;
		taskId: string;
		turn: number;
	}) => Promise<RuntimeTaskTurnCheckpoint>;
	deleteTaskTurnCheckpointRef?: (input: { cwd: string; ref: string }) => Promise<void>;
	recordTaskHistoryEvent?: typeof recordTaskHistoryEvent;
}

async function firstLine(path: string): Promise<string | null> {
	const file = await open(path, "r").catch(() => null);
	if (!file) return null;
	try {
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const contents = buffer.toString("utf8", 0, bytesRead);
		const newline = contents.indexOf("\n");
		return newline < 0 ? contents : contents.slice(0, newline);
	} finally {
		await file.close();
	}
}

async function newestJsonl(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const path = join(directory, entry.name);
				return { path, modifiedAt: (await stat(path).catch(() => ({ mtimeMs: 0 }))).mtimeMs };
			}),
	);
	return files.sort((a, b) => b.modifiedAt - a.modifiedAt).map(({ path }) => path);
}

function codexSessionDirectories(now = new Date()): string[] {
	return [0, 1].map((daysAgo) => {
		const date = new Date(now);
		date.setDate(date.getDate() - daysAgo);
		return join(
			homedir(),
			".codex",
			"sessions",
			String(date.getFullYear()),
			String(date.getMonth() + 1).padStart(2, "0"),
			String(date.getDate()).padStart(2, "0"),
		);
	});
}

async function recordedTranscriptPath(path: string, allowedHome: string): Promise<string | null> {
	if (!isAbsolute(path)) return null;
	try {
		const [actualPath, actualHome] = await Promise.all([realpath(path), realpath(allowedHome)]);
		const relativePath = relative(actualHome, actualPath);
		return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)) ? actualPath : null;
	} catch {
		return null;
	}
}

async function findWorkspaceTranscript(
	agentId: string,
	workspacePath: string,
	metadata?: Partial<RuntimeTaskHookActivity>,
): Promise<{ id: string; path: string } | null> {
	const home = homedir();
	if (agentId === "antigravity" && metadata?.conversationId && metadata.transcriptPath) {
		const allowedHome = join(home, ".gemini", "antigravity-cli");
		const path = await recordedTranscriptPath(metadata.transcriptPath, allowedHome);
		return path ? { id: metadata.conversationId, path } : null;
	}
	const directories =
		agentId === "codex"
			? codexSessionDirectories()
			: agentId === "claude"
				? [join(home, ".claude", "projects", resolve(workspacePath).replaceAll(/[/.]/gu, "-"))]
				: []; // shortcut: OpenCode sessions are skipped until SQLite directory matching is implemented.
	for (const directory of directories) {
		for (const path of await newestJsonl(directory)) {
			const line = await firstLine(path);
			try {
				const first = JSON.parse(line ?? "") as Record<string, unknown>;
				const session = agentId === "codex" ? (first.payload as Record<string, unknown> | undefined) : first;
				if (agentId === "claude" || resolve(String(session?.cwd ?? "")) === resolve(workspacePath)) {
					const id =
						agentId === "codex"
							? String(session?.session_id ?? session?.id ?? "")
							: String(first.sessionId ?? first.session_id ?? "");
					if (id) return { id, path };
				}
			} catch {}
		}
	}
	return null;
}

function scheduleSessionCapture(
	workspaceId: string,
	taskId: string,
	agentId: string,
	workspacePath: string,
	metadata: Partial<RuntimeTaskHookActivity> | undefined,
	recordHistory: typeof recordTaskHistoryEvent,
): void {
	setImmediate(() => {
		void findWorkspaceTranscript(agentId, workspacePath, metadata)
			.then(async (session) => {
				if (!session) return;
				const event: Omit<TaskHistoryEvent, "at"> = {
					type: "session",
					agentId,
					agentSession: { agentId, id: session.id, transcriptPath: session.path },
				};
				await recordHistory(workspaceId, taskId, event);
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				process.emitWarning(`Failed to capture ${agentId} transcript for ${taskId}: ${message}`, {
					type: "AgentTranscriptCaptureWarning",
				});
			});
	});
}

function canTransitionTaskForHookEvent(summary: RuntimeTaskSessionSummary, event: RuntimeHookEvent): boolean {
	if (event === "activity") {
		return false;
	}
	if (event === "to_review") {
		return summary.state === "running";
	}
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

export function createHooksApi(deps: CreateHooksApiDependencies): RuntimeTrpcContext["hooksApi"] {
	const checkpointCapture = deps.captureTaskTurnCheckpoint ?? captureTaskTurnCheckpoint;
	const checkpointRefDelete = deps.deleteTaskTurnCheckpointRef ?? deleteTaskTurnCheckpointRef;
	const recordHistory = deps.recordTaskHistoryEvent ?? recordTaskHistoryEvent;

	return {
		ingest: async (input) => {
			try {
				const body = parseHookIngestRequest(input);
				const taskId = body.taskId;
				const workspaceId = body.workspaceId;
				const event = body.event;
				const source = body.metadata?.source?.toLowerCase();
				const knownWorkspacePath = deps.getWorkspacePathById(workspaceId);
				const workspaceContext = knownWorkspacePath ? null : await loadWorkspaceContextById(workspaceId);
				const workspacePath = knownWorkspacePath ?? workspaceContext?.repoPath ?? null;
				if (!workspacePath) {
					return {
						ok: false,
						error: `Workspace "${workspaceId}" not found`,
					} satisfies RuntimeHookIngestResponse;
				}

				const manager = await deps.ensureTerminalManagerForWorkspace(workspaceId, workspacePath);
				const summary = manager.getSummary(taskId);
				if (!summary) {
					return {
						ok: false,
						error: `Task "${taskId}" not found in workspace "${workspaceId}"`,
					} satisfies RuntimeHookIngestResponse;
				}
				if (event === "to_review" && source && summary.agentId && source !== summary.agentId) {
					return { ok: true } satisfies RuntimeHookIngestResponse;
				}

				if (!canTransitionTaskForHookEvent(summary, event)) {
					if (body.metadata) {
						manager.applyHookActivity(taskId, body.metadata);
					}
					return {
						ok: true,
					} satisfies RuntimeHookIngestResponse;
				}

				const transitionedSummary =
					event === "to_review" ? manager.transitionToReview(taskId, "hook") : manager.transitionToRunning(taskId);
				if (!transitionedSummary) {
					return {
						ok: false,
						error: `Task "${taskId}" transition failed`,
					} satisfies RuntimeHookIngestResponse;
				}

				if (event === "to_review") {
					const nextTurn = (transitionedSummary.latestTurnCheckpoint?.turn ?? 0) + 1;
					const checkpointCwd = transitionedSummary.workspacePath ?? workspacePath;
					const staleRef = transitionedSummary.previousTurnCheckpoint?.ref ?? null;
					try {
						const checkpoint = await checkpointCapture({
							cwd: checkpointCwd,
							taskId,
							turn: nextTurn,
						});
						manager.applyTurnCheckpoint(taskId, checkpoint);
						if (staleRef) {
							void checkpointRefDelete({
								cwd: checkpointCwd,
								ref: staleRef,
							}).catch(() => {
								// Best effort cleanup only.
							});
						}
					} catch {
						// Best effort checkpointing only.
					}
				}

				if (body.metadata) {
					manager.applyHookActivity(taskId, body.metadata);
				}

				void deps.broadcastRuntimeWorkspaceStateUpdated(workspaceId, workspacePath);
				if (event === "to_review") {
					deps.broadcastTaskReadyForReview(workspaceId, taskId);
					if (summary.agentId && body.metadata?.source) {
						scheduleSessionCapture(
							workspaceId,
							taskId,
							summary.agentId,
							transitionedSummary.workspacePath ?? workspacePath,
							body.metadata,
							recordHistory,
						);
					}
				}

				return { ok: true } satisfies RuntimeHookIngestResponse;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: message } satisfies RuntimeHookIngestResponse;
			}
		},
	};
}
