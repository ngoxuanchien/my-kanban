import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readGithubIssueMap, setGithubIssueMetadata, setGithubIssueSummary } from "../../../src/github/issue-map";
import { getWorkspaceDirectoryPath } from "../../../src/state/workspace-state";
import { createTempDir } from "../../utilities/temp-dir";

let temp: ReturnType<typeof createTempDir>;
beforeEach(() => {
	temp = createTempDir("issue-map-");
	vi.stubEnv("HOME", temp.path);
	vi.stubEnv("USERPROFILE", temp.path);
});
afterEach(() => {
	vi.unstubAllEnvs();
	temp.cleanup();
});
it("reads missing mapping as empty", async () => {
	expect(await readGithubIssueMap("workspace")).toEqual({});
});
it("trims summaries and ignores empty summaries", async () => {
	await setGithubIssueSummary("workspace", "task", "  public summary \n");
	await setGithubIssueSummary("workspace", "task", " \n");
	expect(await readGithubIssueMap("workspace")).toEqual({ task: { summary: "public summary" } });
});
it("locks concurrent summary writes without losing entries", async () => {
	await Promise.all([
		setGithubIssueSummary("workspace", "one", "first"),
		setGithubIssueSummary("workspace", "two", "second"),
	]);
	expect(await readGithubIssueMap("workspace")).toEqual({ one: { summary: "first" }, two: { summary: "second" } });
});
it("preserves issue metadata when updating a summary", async () => {
	const dir = getWorkspaceDirectoryPath("workspace");
	await mkdir(dir, { recursive: true });
	const entry = { issueNumber: 12, issueUrl: "https://github.com/o/r/issues/12", closed: true, syncedColumn: "trash" };
	await writeFile(join(dir, "github-issues.json"), JSON.stringify({ task: entry }));
	await setGithubIssueSummary("workspace", "task", "new");
	expect(await readGithubIssueMap("workspace")).toEqual({ task: { ...entry, summary: "new" } });
});
it("stores metadata without losing the entry or other fields", async () => {
	await setGithubIssueSummary("workspace", "task", "body");
	await setGithubIssueMetadata("workspace", "task", { labels: [" a ", "b", "a", ""], milestone: " M " });
	await setGithubIssueMetadata("workspace", "task", { assignee: "u" });
	await setGithubIssueMetadata("workspace", "task", { labels: [], milestone: "  " });
	expect(await readGithubIssueMap("workspace")).toEqual({
		task: { summary: "body", labels: ["a", "b"], milestone: "M", assignee: "u" },
	});
});
it("rejects corrupt mappings instead of silently recreating issues", async () => {
	const dir = getWorkspaceDirectoryPath("workspace");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "github-issues.json"), '{"task":{"issueNumber":"bad"}}');
	await expect(readGithubIssueMap("workspace")).rejects.toThrow();
});
