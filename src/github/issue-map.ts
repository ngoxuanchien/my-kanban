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
	skipped?: boolean;
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
		skipped: z.boolean().optional(),
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
