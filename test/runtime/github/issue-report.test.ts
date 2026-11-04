import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	deleteIssueReport,
	hashReport,
	ISSUE_REPORT_FILE,
	issueReportInstruction,
	readIssueReport,
} from "../../../src/github/issue-report";

let dir = "";
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});
it("reads, hashes, and deletes a report; absent reports return null", async () => {
	dir = await mkdtemp(join(tmpdir(), "issue-report-"));
	expect(await readIssueReport(dir)).toBeNull();
	await writeFile(join(dir, ISSUE_REPORT_FILE), "report");
	expect(await readIssueReport(dir)).toBe("report");
	expect(hashReport("report")).toBe(hashReport("report"));
	await deleteIssueReport(dir);
	expect(await readIssueReport(dir)).toBeNull();
	expect(await readFile(join(dir, ISSUE_REPORT_FILE), "utf8").catch(() => "")).toBe("");
	expect(issueReportInstruction()).toContain(ISSUE_REPORT_FILE);
});
