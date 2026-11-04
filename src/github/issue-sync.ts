import { loadRuntimeConfig, type RuntimeConfigState } from "../config/runtime-config";
import { resolveTaskAgentModel } from "../core/agent-model";
import type { RuntimeBoardCard, RuntimeBoardColumnId } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { loadTaskHistory } from "../state/task-history";
import { loadWorkspaceBoardById, loadWorkspaceState } from "../state/workspace-state";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { formatDoneComment, formatImplementationUpdate, formatStatusComment } from "./comment-format";
import type { GhRunner } from "./gh-runner";
import { getGithubIssueMapPath, readGithubIssueMap } from "./issue-map";
import { deleteIssueReport, hashReport, readIssueReport } from "./issue-report";
import { sanitizeForGithub } from "./sanitize";

export interface GithubIssueSyncDeps {
	runGh: GhRunner;
	getOriginRemoteUrl: (repoPath: string) => Promise<string>;
	warn: (message: string) => void;
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
}
export interface GithubIssueSyncResult {
	ok: boolean;
	created: number;
	updated: number;
	closed: number;
	error?: string;
}
const labels: Partial<Record<RuntimeBoardColumnId, string>> = {
	backlog: "kanban: backlog",
	in_progress: "kanban: in progress",
	review: "kanban: review",
};
const titles = { backlog: "Backlog", in_progress: "In progress", review: "Review", trash: "Done" };

// Reports what the session launched. A record from another agent says nothing about this card's current run.
async function describeTaskRun(card: RuntimeBoardCard, config: RuntimeConfigState, repoPath: string): Promise<string> {
	const sessions = await loadWorkspaceState(repoPath).then(
		(state) => state.sessions,
		() => null,
	);
	const session = sessions?.[card.id];
	const agentId = card.agentId ?? session?.agentId;
	if (!agentId) return "";
	const recorded = session?.agentId === agentId ? session : undefined;
	const model =
		agentId === "claude"
			? (recorded?.claudeModel ??
				resolveTaskAgentModel({
					agentId,
					card,
					map: config.difficultyModelMap,
					claudeDefaultModel: config.claudeDefaultModel,
				}).model)
			: agentId === "cline"
				? card.clineSettings?.modelId
				: recorded?.agentModel;
	const effort = model ? recorded?.agentReasoningEffort : null;
	return `${agentId}${model ? `, model: ${model}` : ""}${effort ? `, effort: ${effort}` : ""}`;
}

export async function reconcileGithubIssues(
	input: { workspaceId: string; repoPath: string },
	deps: GithubIssueSyncDeps,
): Promise<GithubIssueSyncResult> {
	const result: GithubIssueSyncResult = { ok: true, created: 0, updated: 0, closed: 0 };
	try {
		const config = await loadRuntimeConfig(input.repoPath);
		if (!config.githubIssueSyncEnabled) return result;
		let origin: string;
		try {
			origin = await deps.getOriginRemoteUrl(input.repoPath);
		} catch {
			throw new Error("Could not resolve the project's origin remote URL.");
		}
		const remote = /^(?:https?:\/\/github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
			origin,
		);
		if (!remote?.[1]) throw new Error(`Could not parse the project's origin remote URL: ${origin || "empty URL"}`);
		const repo = remote[1];
		const path = getGithubIssueMapPath(input.workspaceId);
		let mapChangedForBroadcast = false;
		await lockedFileSystem.withLock(
			{ path, type: "file", retries: { retries: 1200, minTimeout: 50, maxTimeout: 50, factor: 1 } },
			async () => {
				const map = await readGithubIssueMap(input.workspaceId);
				const board = await loadWorkspaceBoardById(input.workspaceId);
				const save = () => lockedFileSystem.writeJsonFileAtomic(path, map, { lock: null });
				let changed = false;
				let changedForBroadcast = false;
				const gh = (args: string[]) =>
					deps.runGh([...args.map(sanitizeForGithub), "--repo", repo], { cwd: input.repoPath });
				const ensured = new Set<string>();
				const ensureLabel = async (label: string) => {
					if (!ensured.has(label)) {
						await gh(["label", "create", label, "--force"]);
						ensured.add(label);
					}
				};
				const present = new Set<string>();
				for (const column of board.columns)
					for (const card of column.cards) {
						present.add(card.id);
						if (!Object.hasOwn(map, card.id)) {
							map[card.id] = column.id === "trash" ? { skipped: true } : {};
							changed = true;
							changedForBroadcast = true;
						}
					}
				if (changed) await save();
				for (const column of board.columns)
					for (const card of column.cards) {
						let entry = map[card.id];
						if (!entry || entry.skipped) continue;
						try {
							const title = card.title || `Task ${card.id}`;
							if (!entry.issueNumber) {
								const body = entry.summary
									? `${entry.summary}\n\n---\nKanban task: ${card.id}`
									: `Kanban task: ${card.id}`;
								const label = labels[column.id];
								if (label) await ensureLabel(label);
								const args = ["issue", "create", "--title", title, "--body", body];
								if (label) args.push("--label", label);
								const url = (await gh(args)).stdout.trim();
								const match = /\/issues\/(\d+)$/.exec(url);
								if (!match || !/^https?:\/\//.test(url))
									throw new Error("gh issue create returned an invalid issue URL");
								entry = {
									...entry,
									issueNumber: Number(match[1]),
									issueUrl: url,
									syncedColumn: column.id,
									closed: false,
									syncedSummary: entry.summary,
									syncedTitle: title,
								};
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
								result.created++;
								if (column.id !== "trash") continue;
							}
							const number = String(entry.issueNumber);
							if (entry.syncedTitle !== title) {
								await gh(["issue", "edit", number, "--title", title]);
								entry = { ...entry, syncedTitle: title };
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
							}
							if (entry.summary !== entry.syncedSummary) {
								await gh([
									"issue",
									"edit",
									number,
									"--body",
									`${entry.summary}\n\n---\nKanban task: ${card.id}`,
								]);
								entry = { ...entry, syncedSummary: entry.summary };
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
							}
							if (column.id === "review") {
								let worktree: string | null = null;
								try {
									worktree = await resolveTaskCwd({
										cwd: input.repoPath,
										taskId: card.id,
										baseRef: card.baseRef,
									});
								} catch (error) {
									if (!(error instanceof Error) || !error.message.startsWith("Task worktree not found"))
										throw error;
								}
								const report = worktree ? await readIssueReport(worktree) : null;
								if (report && worktree) {
									const reportHash = hashReport(report);
									if (entry.reportHash !== reportHash) {
										const agent = await describeTaskRun(card, config, input.repoPath);
										await gh([
											"issue",
											"comment",
											number,
											"--body",
											formatImplementationUpdate({
												agent: agent || card.agentId || "unknown",
												base: card.baseRef,
												report,
											}),
										]);
										entry = { ...entry, reportHash };
										map[card.id] = entry;
										await save();
										changed = true;
										changedForBroadcast = true;
									}
									await deleteIssueReport(worktree);
								}
							}
							if (column.id === "trash") {
								if (entry.closed) continue;
								const history = await loadTaskHistory(input.workspaceId, card.id);
								const commit = history
									.filter((event) => event.type === "pass" && event.commit)
									.sort((a, b) => b.at - a.at)[0]?.commit;
								if (!entry.doneCommented) {
									await gh(["issue", "comment", number, "--body", formatDoneComment(commit)]);
									entry = { ...entry, doneCommented: true };
									map[card.id] = entry;
									await save();
									changed = true;
									changedForBroadcast = true;
								}
								const prior = entry.syncedColumn && labels[entry.syncedColumn];
								if (prior) {
									await gh(["issue", "edit", number, "--remove-label", prior]);
									entry = { ...entry, syncedColumn: "trash" };
									map[card.id] = entry;
									await save();
									changed = true;
									changedForBroadcast = true;
								}
								await gh(["issue", "close", number, "--reason", "completed"]);
								map[card.id] = { ...entry, syncedColumn: "trash", closed: true, lastError: undefined };
								await save();
								changed = true;
								changedForBroadcast = true;
								result.closed++;
							} else if (entry.closed || entry.syncedColumn !== column.id) {
								const label = labels[column.id];
								if (!label) continue;
								await ensureLabel(label);
								if (entry.closed) await gh(["issue", "reopen", number]);
								const args = ["issue", "edit", number, "--add-label", label];
								const prior = entry.syncedColumn && labels[entry.syncedColumn];
								if (prior && prior !== label) args.push("--remove-label", prior);
								await gh(args);
								const agent = entry.closed ? "" : await describeTaskRun(card, config, input.repoPath);
								await gh([
									"issue",
									"comment",
									number,
									"--body",
									formatStatusComment(
										agent || card.agentId || "unknown",
										entry.closed ? `Reopened, moved to ${titles[column.id]}` : titles[column.id],
									),
								]);
								map[card.id] = {
									...entry,
									syncedColumn: column.id,
									closed: false,
									doneCommented: false,
									lastError: undefined,
								};
								await save();
								changed = true;
								changedForBroadcast = true;
								result.updated++;
							}
							if (entry.lastError) {
								map[card.id] = { ...map[card.id], lastError: undefined };
								await save();
								changed = true;
							}
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							map[card.id] = { ...map[card.id], lastError: message };
							await save();
							changed = true;
							result.ok = false;
							result.error ??= message;
							deps.warn(`[kanban] GitHub issue sync failed for task ${card.id}: ${message}`);
						}
					}
				for (const [taskId, entry] of Object.entries(map))
					if (!present.has(taskId) && entry.issueNumber && !entry.closed) {
						try {
							const label = entry.syncedColumn && labels[entry.syncedColumn];
							if (label) await gh(["issue", "edit", String(entry.issueNumber), "--remove-label", label]);
							await gh(["issue", "close", String(entry.issueNumber), "--reason", "not planned"]);
							map[taskId] = { ...entry, closed: true, lastError: undefined };
							await save();
							changed = true;
							changedForBroadcast = true;
							result.closed++;
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							map[taskId] = { ...entry, lastError: message };
							await save();
							changed = true;
							result.ok = false;
							result.error ??= message;
							deps.warn(`[kanban] GitHub issue sync failed for task ${taskId}: ${message}`);
						}
					}
				if (changedForBroadcast) mapChangedForBroadcast = true;
			},
		);
		if (mapChangedForBroadcast) await deps.broadcastRuntimeWorkspaceStateUpdated?.(input.workspaceId, input.repoPath);
	} catch (error) {
		result.ok = false;
		result.error = error instanceof Error ? error.message : String(error);
		deps.warn(`[kanban] GitHub issue sync failed: ${result.error}`);
	}
	return result;
}

export interface GithubIssueSyncService {
	requestSync(workspaceId: string, repoPath: string): void;
	syncNow(workspaceId: string, repoPath: string): Promise<GithubIssueSyncResult>;
}

export function createGithubIssueSyncService(deps: GithubIssueSyncDeps): GithubIssueSyncService {
	type Run = { current: Promise<GithubIssueSyncResult>; queued?: Promise<GithubIssueSyncResult> };
	const runs = new Map<string, Run>();
	const syncNow = (workspaceId: string, repoPath: string): Promise<GithubIssueSyncResult> => {
		const running = runs.get(workspaceId);
		if (running) {
			if (!running.queued) {
				running.queued = running.current.then(() => {
					runs.delete(workspaceId);
					return syncNow(workspaceId, repoPath);
				});
			}
			return running.queued;
		}
		const run: Run = { current: reconcileGithubIssues({ workspaceId, repoPath }, deps) };
		runs.set(workspaceId, run);
		void run.current.then(() => {
			if (!run.queued) runs.delete(workspaceId);
		});
		return run.current;
	};
	return {
		syncNow,
		requestSync: (workspaceId, repoPath) => {
			void syncNow(workspaceId, repoPath);
		},
	};
}
