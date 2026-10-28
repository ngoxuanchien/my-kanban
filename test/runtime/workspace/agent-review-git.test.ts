import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AgentReviewGitError,
	captureWorktreeSnapshot,
	computeTaskReviewFingerprint,
	diffWorktreeSnapshots,
} from "../../../src/workspace/agent-review-git";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: createGitTestEnv() });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

describe("agent-review-git", () => {
	let repo: string;
	let cleanup: () => void;

	beforeEach(() => {
		const temp = createTempDir("kanban-agent-review-git-");
		repo = temp.path;
		cleanup = temp.cleanup;
		git(repo, ["init", "-q", "-b", "main"]);
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "package-lock.json"), "{}\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-q", "-m", "init"]);
		git(repo, ["checkout", "-q", "-b", "task"]);
	});

	afterEach(() => {
		cleanup();
	});

	it("snapshot diff is empty when nothing changed", async () => {
		const before = await captureWorktreeSnapshot(repo);
		const after = await captureWorktreeSnapshot(repo);
		expect(diffWorktreeSnapshots(before, after)).toEqual([]);
	});

	it("detects a modified tracked file, a new untracked file, a new commit, a branch switch and a new stash", async () => {
		let before = await captureWorktreeSnapshot(repo);
		writeFileSync(join(repo, "a.txt"), "changed\n");
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["a.txt"]);
		git(repo, ["checkout", "-q", "a.txt"]);

		before = await captureWorktreeSnapshot(repo);
		writeFileSync(join(repo, "new.txt"), "new\n");
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["new.txt"]);
		git(repo, ["clean", "-fq"]);

		before = await captureWorktreeSnapshot(repo);
		git(repo, ["commit", "-q", "--allow-empty", "-m", "empty"]);
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["HEAD"]);

		before = await captureWorktreeSnapshot(repo);
		git(repo, ["checkout", "-q", "-b", "other"]);
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["branch"]);

		writeFileSync(join(repo, "a.txt"), "stash me\n");
		before = await captureWorktreeSnapshot(repo);
		git(repo, ["stash", "-q"]);
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["a.txt", "stash"]);
	});

	it("ignores changes under gitignored paths", async () => {
		const before = await captureWorktreeSnapshot(repo);
		mkdirSync(join(repo, "node_modules"));
		writeFileSync(join(repo, "node_modules", "x"), "x\n");
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual([]);
	});

	it("detects a lockfile rewrite with the same status letter", async () => {
		writeFileSync(join(repo, "package-lock.json"), '{"v":1}\n');
		const before = await captureWorktreeSnapshot(repo);
		writeFileSync(join(repo, "package-lock.json"), '{"v":2}\n');
		expect(diffWorktreeSnapshots(before, await captureWorktreeSnapshot(repo))).toEqual(["package-lock.json"]);
	});

	it("hasChanges is true for committed-only changes on the task branch", async () => {
		writeFileSync(join(repo, "a.txt"), "committed\n");
		git(repo, ["commit", "-q", "-am", "change"]);
		const result = await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" });
		expect(result.hasChanges).toBe(true);
	});

	it("hasChanges is false for a clean branch at the base", async () => {
		const result = await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" });
		expect(result.hasChanges).toBe(false);
	});

	it("fingerprint is the same after committing the same content", async () => {
		writeFileSync(join(repo, "a.txt"), "work\n");
		const fp1 = (await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" })).fingerprint;
		git(repo, ["commit", "-q", "-am", "work"]);
		const fp2 = (await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" })).fingerprint;
		expect(fp2).toBe(fp1);
	});

	it("fingerprint changes when content changes", async () => {
		writeFileSync(join(repo, "a.txt"), "one\n");
		const fp1 = (await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" })).fingerprint;
		writeFileSync(join(repo, "untracked.txt"), "two\n");
		const fp2 = (await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" })).fingerprint;
		expect(fp2).not.toBe(fp1);
	});

	it("does not touch the real index", async () => {
		writeFileSync(join(repo, "a.txt"), "unstaged\n");
		writeFileSync(join(repo, "untracked.txt"), "u\n");
		const statusBefore = git(repo, ["status", "--porcelain=v1"]);
		await computeTaskReviewFingerprint({ cwd: repo, baseRef: "main" });
		expect(git(repo, ["status", "--porcelain=v1"])).toBe(statusBefore);
	});

	it("throws AgentReviewGitError when baseRef does not exist", async () => {
		await expect(computeTaskReviewFingerprint({ cwd: repo, baseRef: "missing-branch" })).rejects.toBeInstanceOf(
			AgentReviewGitError,
		);
	});
});
