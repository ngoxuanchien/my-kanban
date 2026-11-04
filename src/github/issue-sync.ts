import { loadRuntimeConfig } from "../config/runtime-config";
import type { RuntimeBoardColumnId } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { loadTaskHistory } from "../state/task-history";
import { loadWorkspaceBoardById } from "../state/workspace-state";
import type { GhRunner } from "./gh-runner";
import { getGithubIssueMapPath, readGithubIssueMap } from "./issue-map";

export interface GithubIssueSyncDeps {
	runGh: GhRunner;
	warn: (message: string) => void;
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

export async function reconcileGithubIssues(
	input: { workspaceId: string; repoPath: string },
	deps: GithubIssueSyncDeps,
): Promise<GithubIssueSyncResult> {
	const result: GithubIssueSyncResult = { ok: true, created: 0, updated: 0, closed: 0 };
	try {
		const config = await loadRuntimeConfig(input.repoPath);
		if (!config.githubIssueSyncEnabled) return result;
		const path = getGithubIssueMapPath(input.workspaceId);
		await lockedFileSystem.withLock(
			{ path, type: "file", retries: { retries: 1200, minTimeout: 50, maxTimeout: 50, factor: 1 } },
			async () => {
				const map = await readGithubIssueMap(input.workspaceId);
				const board = await loadWorkspaceBoardById(input.workspaceId);
				const save = () => lockedFileSystem.writeJsonFileAtomic(path, map, { lock: null });
				const gh = (args: string[]) => deps.runGh(args, { cwd: input.repoPath });
				const ensured = new Set<string>();
				const ensureLabel = async (label: string) => {
					if (ensured.has(label)) return;
					await gh(["label", "create", label, "--force"]);
					ensured.add(label);
				};
				const present = new Set<string>();
				let discovered = false;
				for (const column of board.columns) {
					for (const card of column.cards) {
						present.add(card.id);
						if (!Object.hasOwn(map, card.id)) {
							map[card.id] = column.id === "trash" ? { skipped: true } : {};
							discovered = true;
						}
					}
				}
				// Remember every open task before a GitHub failure can abort this run.
				if (discovered) await save();
				for (const column of board.columns) {
					for (const card of column.cards) {
						let entry = map[card.id];
						if (entry.skipped) continue;
						if (!entry.issueNumber) {
							const title = card.title || `Task ${card.id}`;
							const body = entry.summary
								? `${entry.summary}\n\n---\nKanban task: ${card.id}`
								: `Kanban task: ${card.id}`;
							const label = labels[column.id];
							if (label) await ensureLabel(label);
							const args = ["issue", "create", "--title", title, "--body", body];
							if (label) args.push("--label", label);
							const { stdout } = await gh(args);
							const url = stdout.trim();
							const number = /\/issues\/(\d+)$/.exec(url)?.[1];
							if (!number || !/^https?:\/\//.test(url))
								throw new Error("gh issue create returned an invalid issue URL");
							entry = {
								...entry,
								issueNumber: Number(number),
								issueUrl: url,
								syncedColumn: column.id,
								closed: false,
							};
							map[card.id] = entry;
							await save();
							result.created++;
							if (column.id !== "trash") continue;
						}
						const number = String(entry.issueNumber);
						if (column.id === "trash") {
							if (entry.closed) continue;
							const history = await loadTaskHistory(input.workspaceId, card.id);
							const commit = history
								.filter((event) => event.type === "pass" && event.commit)
								.sort((a, b) => b.at - a.at)[0]?.commit;
							await gh([
								"issue",
								"comment",
								number,
								"--body",
								commit ? `Done in commit ${commit}` : "Moved to Done",
							]);
							const previousLabel = entry.syncedColumn && labels[entry.syncedColumn];
							if (previousLabel) await gh(["issue", "edit", number, "--remove-label", previousLabel]);
							await gh(["issue", "close", number, "--reason", "completed"]);
							map[card.id] = { ...entry, syncedColumn: "trash", closed: true };
							result.closed++;
						} else if (entry.closed || entry.syncedColumn !== column.id) {
							const label = labels[column.id];
							if (!label) continue;
							await ensureLabel(label);
							if (entry.closed) await gh(["issue", "reopen", number]);
							const args = ["issue", "edit", number, "--add-label", label];
							const previousLabel = entry.syncedColumn && labels[entry.syncedColumn];
							if (previousLabel && previousLabel !== label) args.push("--remove-label", previousLabel);
							await gh(args);
							const model =
								card.agentId === "claude"
									? (card.claudeModel ?? config.claudeDefaultModel)
									: card.agentId === "cline"
										? card.clineSettings?.modelId
										: undefined;
							await gh([
								"issue",
								"comment",
								number,
								"--body",
								`${entry.closed ? "Reopened, moved" : "Moved"} to ${titles[column.id]}${!entry.closed && card.agentId ? ` (agent: ${card.agentId}${model ? `, model: ${model}` : ""})` : ""}`,
							]);
							map[card.id] = { ...entry, syncedColumn: column.id, closed: false };
							result.updated++;
						} else continue;
						await save();
					}
				}
				for (const [taskId, entry] of Object.entries(map)) {
					if (present.has(taskId) || !entry.issueNumber || entry.closed) continue;
					const label = entry.syncedColumn && labels[entry.syncedColumn];
					if (label) await gh(["issue", "edit", String(entry.issueNumber), "--remove-label", label]);
					await gh(["issue", "close", String(entry.issueNumber), "--reason", "not planned"]);
					map[taskId] = { ...entry, closed: true };
					await save();
					result.closed++;
				}
			},
		);
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
