import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export const ISSUE_REPORT_FILE = ".kanban-issue-report.md";

export async function readIssueReport(worktreePath: string): Promise<string | null> {
	try {
		return await readFile(join(worktreePath, ISSUE_REPORT_FILE), "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export async function deleteIssueReport(worktreePath: string): Promise<void> {
	await unlink(join(worktreePath, ISSUE_REPORT_FILE)).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

export function hashReport(report: string): string {
	return createHash("sha256").update(report).digest("hex");
}

export function issueReportInstruction(): string {
	return "When you finish, write your report to `.kanban-issue-report.md` at the worktree root with these `###` sections: Summary, Changes, Tests, References, Next Steps. Do not mention `contexte/`, local paths, or internal notes. Do not call `gh`.";
}
