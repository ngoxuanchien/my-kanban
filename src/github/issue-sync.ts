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
import { type BoardMutator, issueBody, mutateBoardLocked, pullGithubChanges } from "./reverse-sync";
import { formatIssueReview } from "./review-comment";
import { sanitizeForGithub } from "./sanitize";

export interface GithubIssueSyncDeps {
	runGh: GhRunner;
	getOriginRemoteUrl: (repoPath: string) => Promise<string>;
	warn: (message: string) => void;
	broadcastRuntimeWorkspaceStateUpdated?: (workspaceId: string, workspacePath: string) => Promise<void> | void;
	// Board writes made by the pull pass. Defaults to the locked workspace state path; tests inject a fake.
	mutateBoard?: BoardMutator;
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
	input: { workspaceId: string; repoPath: string; pull?: boolean },
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
				let board = await loadWorkspaceBoardById(input.workspaceId);
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
				// ponytail: a skipped label is retried (one `gh label list` plus a warning) on every reconcile.
				let repoLabels: Set<string> | undefined;
				// `kanban:` labels are created (--force); any other label must already exist, so a user's label is never rewritten.
				const usableLabels = async (wanted: string[]): Promise<string[]> => {
					const usable: string[] = [];
					for (const label of wanted) {
						if (label.startsWith("kanban:")) {
							await ensureLabel(label);
							usable.push(label);
							continue;
						}
						repoLabels ??= new Set(
							(
								JSON.parse((await gh(["label", "list", "--limit", "1000", "--json", "name"])).stdout) as {
									name: string;
								}[]
							).map((entry) => entry.name),
						);
						if (repoLabels.has(label)) usable.push(label);
						else deps.warn(`[kanban] GitHub label "${label}" does not exist on ${repo}; skipped.`);
					}
					return usable;
				};
				const withMilestone = async <T>(milestone: string | undefined, run: () => Promise<T>): Promise<T> => {
					try {
						return await run();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (milestone && /milestone/i.test(message))
							throw new Error(`Milestone "${milestone}" was not found or could not be set: ${message}`);
						throw error;
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
				// Pull only on the poll tick and Sync now: board changes also request a reconcile, and those must
				// not cost a gh read per issue.
				if (input.pull) {
					const pulled = await pullGithubChanges({
						workspaceId: input.workspaceId,
						repoPath: input.repoPath,
						board,
						map,
						gh,
						mutateBoard: deps.mutateBoard ?? mutateBoardLocked,
						save,
						warn: deps.warn,
					});
					if (!pulled.ok) {
						result.ok = false;
						result.error ??= pulled.error;
					}
					if (pulled.boardChanged || pulled.summaryChanged) changedForBroadcast = true;
					if (pulled.boardChanged) board = await loadWorkspaceBoardById(input.workspaceId);
				}
				for (const column of board.columns)
					for (const card of column.cards) {
						let entry = map[card.id];
						if (!entry || entry.skipped) continue;
						try {
							const title = card.title || `Task ${card.id}`;
							if (!entry.issueNumber) {
								const body = issueBody(entry.summary, card.id);
								const label = labels[column.id];
								if (label) await ensureLabel(label);
								const args = ["issue", "create", "--title", title, "--body", body];
								if (label) args.push("--label", label);
								const userLabels = await usableLabels(entry.labels ?? []);
								const assignee = entry.assignee ?? "@me";
								for (const userLabel of userLabels) args.push("--label", userLabel);
								if (entry.milestone) args.push("--milestone", entry.milestone);
								args.push("--assignee", assignee);
								const url = (await withMilestone(entry.milestone, () => gh(args))).stdout.trim();
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
									syncedLabels: userLabels.length > 0 ? userLabels : undefined,
									syncedMilestone: entry.milestone,
									syncedAssignee: assignee,
									syncedBody: sanitizeForGithub(body),
								};
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
								result.created++;
								if (column.id !== "trash" && !entry.pendingReviews?.length) continue;
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
								const body = issueBody(entry.summary, card.id);
								await gh(["issue", "edit", number, "--body", body]);
								entry = { ...entry, syncedSummary: entry.summary, syncedBody: sanitizeForGithub(body) };
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
							}
							const wantedLabels = entry.labels ?? [];
							const ownedLabels = entry.syncedLabels ?? [];
							const addLabels = await usableLabels(wantedLabels.filter((label) => !ownedLabels.includes(label)));
							const removeLabels = ownedLabels.filter((label) => !wantedLabels.includes(label));
							const milestone = entry.milestone !== entry.syncedMilestone ? entry.milestone : undefined;
							const assignee = entry.assignee !== entry.syncedAssignee ? entry.assignee : undefined;
							if (addLabels.length > 0 || removeLabels.length > 0 || milestone || assignee) {
								const editArgs = ["issue", "edit", number];
								for (const label of addLabels) editArgs.push("--add-label", label);
								for (const label of removeLabels) editArgs.push("--remove-label", label);
								if (milestone) editArgs.push("--milestone", milestone);
								if (assignee) {
									editArgs.push("--add-assignee", assignee);
									if (entry.syncedAssignee) editArgs.push("--remove-assignee", entry.syncedAssignee);
								}
								await withMilestone(milestone, () => gh(editArgs));
								entry = {
									...entry,
									syncedLabels: [
										...ownedLabels.filter((label) => !removeLabels.includes(label)),
										...addLabels,
									],
									syncedMilestone: milestone ?? entry.syncedMilestone,
									syncedAssignee: assignee ?? entry.syncedAssignee,
								};
								map[card.id] = entry;
								await save();
								changed = true;
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
							for (const review of entry.pendingReviews ?? []) {
								if (entry.postedReviewIds?.includes(review.id)) continue;
								// task done records the base commit after the sidebar stores its passing review.
								if (review.status === "pass" && column.id !== "trash") continue;
								const history =
									review.status === "pass" ? await loadTaskHistory(input.workspaceId, card.id) : [];
								const commit = history
									.filter((event) => event.type === "pass")
									.sort((a, b) => b.at - a.at)[0]?.commit;
								await gh(["issue", "comment", number, "--body", formatIssueReview(review, commit)]);
								entry = {
									...entry,
									postedReviewIds: [...(entry.postedReviewIds ?? []), review.id],
									doneCommented: review.status === "pass" || entry.doneCommented,
								};
								map[card.id] = entry;
								await save();
								changed = true;
								changedForBroadcast = true;
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

// pull: also read GitHub changes. Set by the poll tick and Sync now, never by a board-change request.
export interface GithubIssueSyncOptions {
	pull?: boolean;
}

export interface GithubIssueSyncService {
	requestSync(workspaceId: string, repoPath: string, options?: GithubIssueSyncOptions): void;
	syncNow(workspaceId: string, repoPath: string, options?: GithubIssueSyncOptions): Promise<GithubIssueSyncResult>;
}

export function createGithubIssueSyncService(deps: GithubIssueSyncDeps): GithubIssueSyncService {
	type Run = {
		current: Promise<GithubIssueSyncResult>;
		queued?: Promise<GithubIssueSyncResult>;
		queuedPull?: boolean;
	};
	const runs = new Map<string, Run>();
	const syncNow = (
		workspaceId: string,
		repoPath: string,
		options: GithubIssueSyncOptions = {},
	): Promise<GithubIssueSyncResult> => {
		const running = runs.get(workspaceId);
		if (running) {
			if (options.pull) running.queuedPull = true;
			if (!running.queued) {
				running.queued = running.current.then(() => {
					runs.delete(workspaceId);
					return syncNow(workspaceId, repoPath, { pull: running.queuedPull });
				});
			}
			return running.queued;
		}
		const run: Run = { current: reconcileGithubIssues({ workspaceId, repoPath, pull: options.pull }, deps) };
		runs.set(workspaceId, run);
		void run.current.then(() => {
			if (!run.queued) runs.delete(workspaceId);
		});
		return run.current;
	};
	return {
		syncNow,
		requestSync: (workspaceId, repoPath, options) => {
			void syncNow(workspaceId, repoPath, options);
		},
	};
}
