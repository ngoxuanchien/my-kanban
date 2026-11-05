import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type RuntimeBoardColumnId, runtimeBoardColumnIdSchema } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getWorkspaceDirectoryPath } from "../state/workspace-state";

const githubIssueReviewSchema = z.object({
	id: z.string(),
	status: z.enum(["pass", "fail"]),
	reviewer: z.string(),
	reviewerModel: z.string().optional(),
	reviewedAt: z.string(),
	body: z.string(),
});
export type GithubIssueReview = z.infer<typeof githubIssueReviewSchema>;

export interface GithubIssueEntry {
	pendingReviews?: GithubIssueReview[];
	postedReviewIds?: string[];
	issueNumber?: number;
	issueUrl?: string;
	syncedColumn?: RuntimeBoardColumnId;
	// Columns whose status comment was already posted for this open issue. A move into a listed column
	// only swaps the label; the comment is noise when the runtime flips the card back and forth.
	commentedColumns?: RuntimeBoardColumnId[];
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
	syncedBody?: string;
	closedNoticed?: boolean;
	lastCommentId?: string;
	// updatedAt from the last `gh issue list` that this entry was pulled at; an unchanged value skips the view.
	pulledUpdatedAt?: string;
}
export type GithubIssueMap = Record<string, GithubIssueEntry>;
const issueMapSchema = z.record(
	z.string(),
	z.object({
		pendingReviews: z.array(githubIssueReviewSchema).optional(),
		postedReviewIds: z.array(z.string()).optional(),
		issueNumber: z.number().int().positive().optional(),
		issueUrl: z.string().url().optional(),
		syncedColumn: runtimeBoardColumnIdSchema.optional(),
		commentedColumns: z.array(runtimeBoardColumnIdSchema).optional(),
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
		syncedBody: z.string().optional(),
		closedNoticed: z.boolean().optional(),
		lastCommentId: z.string().optional(),
		pulledUpdatedAt: z.string().optional(),
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

export async function addGithubIssueReview(
	workspaceId: string,
	taskId: string,
	input: Pick<GithubIssueReview, "status" | "reviewer" | "reviewerModel" | "body">,
): Promise<void> {
	const date = new Date();
	const reviewedAt = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	const review: GithubIssueReview = { ...input, id: randomUUID(), reviewedAt };
	const path = getGithubIssueMapPath(workspaceId);
	await lockedFileSystem.withLock({ path, type: "file" }, async () => {
		const map = await readGithubIssueMap(workspaceId);
		const entry = map[taskId];
		map[taskId] = { ...entry, pendingReviews: [...(entry?.pendingReviews ?? []), review] };
		await lockedFileSystem.writeJsonFileAtomic(path, map, { lock: null });
	});
}
