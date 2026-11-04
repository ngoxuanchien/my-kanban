import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type RuntimeBoardColumnId, runtimeBoardColumnIdSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";

export interface GithubIssueEntry {
	issueNumber?: number;
	issueUrl?: string;
	syncedColumn?: RuntimeBoardColumnId;
	closed?: boolean;
	summary?: string;
	syncedSummary?: string;
	skipped?: boolean;
	syncedTitle?: string;
	doneCommented?: boolean;
	reportHash?: string;
	lastError?: string;
	labels?: string[];
	milestone?: string;
	assignee?: string;
	// What sync last applied to the issue. syncedLabels holds only the user labels sync added (status
	// labels are tracked through syncedColumn), so a label someone else added is never removed.
	syncedLabels?: string[];
	syncedMilestone?: string;
	syncedAssignee?: string;
}
export type GithubIssueMap = Record<string, GithubIssueEntry>;
const issueMapSchema = z.record(
	z.string(),
	z.object({
		issueNumber: z.number().int().positive().optional(),
		issueUrl: z.string().url().optional(),
		syncedColumn: runtimeBoardColumnIdSchema.optional(),
		closed: z.boolean().optional(),
		summary: z.string().optional(),
		syncedSummary: z.string().optional(),
		skipped: z.boolean().optional(),
		syncedTitle: z.string().optional(),
		doneCommented: z.boolean().optional(),
		reportHash: z.string().optional(),
		lastError: z.string().optional(),
		labels: z.array(z.string()).optional(),
		milestone: z.string().optional(),
		assignee: z.string().optional(),
		syncedLabels: z.array(z.string()).optional(),
		syncedMilestone: z.string().optional(),
		syncedAssignee: z.string().optional(),
	}),
);
export const getGithubIssueMapPath = (workspaceId: string): string =>
	join(getWorkspaceDirectoryPath(workspaceId), "github-issues.json");

export async function readGithubIssueMap(workspaceId: string): Promise<GithubIssueMap> {
	let raw: string;
	try {
		raw = await readFile(getGithubIssueMapPath(workspaceId), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return issueMapSchema.parse(JSON.parse(raw));
}

export interface GithubIssueMetadata {
	labels?: string[];
	milestone?: string;
	assignee?: string;
}

// Only the fields that are passed (and non-empty) change; the others keep their stored value.
export async function setGithubIssueMetadata(
	workspaceId: string,
	taskId: string,
	metadata: GithubIssueMetadata,
): Promise<void> {
	const labels = metadata.labels ? [...new Set(metadata.labels.map((label) => label.trim()).filter(Boolean))] : [];
	const milestone = metadata.milestone?.trim();
	const assignee = metadata.assignee?.trim();
	if (labels.length === 0 && !milestone && !assignee) return;
	const path = getGithubIssueMapPath(workspaceId);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const map = await readGithubIssueMap(workspaceId);
		map[taskId] = {
			...map[taskId],
			...(labels.length > 0 ? { labels } : {}),
			...(milestone ? { milestone } : {}),
			...(assignee ? { assignee } : {}),
		};
		await lockedFileSystem.writeJsonFileAtomic(path, map, { lock: null });
	});
}

export async function setGithubIssueSummary(workspaceId: string, taskId: string, summary: string): Promise<void> {
	const trimmed = summary.trim();
	if (!trimmed) return;
	const path = getGithubIssueMapPath(workspaceId);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const map = await readGithubIssueMap(workspaceId);
		map[taskId] = { ...map[taskId], summary: trimmed };
		await lockedFileSystem.writeJsonFileAtomic(path, map, { lock: null });
	});
}
