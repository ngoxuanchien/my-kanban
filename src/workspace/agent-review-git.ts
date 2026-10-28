import { createHash } from "node:crypto";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { type RunGitOptions, runGit } from "./git-utils";

const HASH_OBJECT_BATCH_SIZE = 200;

export class AgentReviewGitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentReviewGitError";
	}
}

export interface WorktreeSnapshot {
	head: string;
	branch: string | null;
	stashList: string;
	/** Path → porcelain status plus content hash ("deleted" when the path is gone). */
	files: Record<string, string>;
}

async function git(cwd: string, args: string[], options: RunGitOptions = {}): Promise<string> {
	const result = await runGit(cwd, args, options);
	if (!result.ok) {
		throw new AgentReviewGitError(result.error ?? `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

function parsePorcelainStatus(output: string): Array<{ status: string; path: string }> {
	const tokens = output.split("\0");
	const entries: Array<{ status: string; path: string }> = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] ?? "";
		if (token.length < 4) {
			continue;
		}
		const status = token.slice(0, 2);
		entries.push({ status, path: token.slice(3) });
		// Renames and copies are followed by their source path.
		if (status[0] === "R" || status[0] === "C") {
			index += 1;
		}
	}
	return entries;
}

export async function captureWorktreeSnapshot(cwd: string): Promise<WorktreeSnapshot> {
	const head = await git(cwd, ["rev-parse", "--verify", "HEAD"]);
	const branchResult = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const stashList = await git(cwd, ["stash", "list", "--format=%H"]);
	const statusOutput = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		trimStdout: false,
	});

	const files: Record<string, string> = {};
	const pathsToHash: string[] = [];
	for (const { status, path } of parsePorcelainStatus(statusOutput)) {
		const stats = await lstat(join(cwd, path)).catch(() => null);
		if (!stats) {
			files[path] = "deleted";
		} else if (stats.isSymbolicLink()) {
			files[path] = `${status}:link:${await readlink(join(cwd, path))}`;
		} else if (stats.isDirectory()) {
			// Submodules show up as directories; their status letter is all we track.
			files[path] = status;
		} else {
			files[path] = status;
			pathsToHash.push(path);
		}
	}
	for (let start = 0; start < pathsToHash.length; start += HASH_OBJECT_BATCH_SIZE) {
		const batch = pathsToHash.slice(start, start + HASH_OBJECT_BATCH_SIZE);
		const hashes = (await git(cwd, ["hash-object", "--", ...batch])).split("\n");
		batch.forEach((path, offset) => {
			files[path] = `${files[path]}:${hashes[offset]}`;
		});
	}

	return { head, branch: branchResult.ok ? branchResult.stdout : null, stashList, files };
}

export function diffWorktreeSnapshots(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
	const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
	const changed = [...paths].filter((path) => before.files[path] !== after.files[path]).sort();
	if (before.head !== after.head) {
		changed.push("HEAD");
	}
	if (before.branch !== after.branch) {
		changed.push("branch");
	}
	if (before.stashList !== after.stashList) {
		changed.push("stash");
	}
	return changed;
}

/**
 * Fingerprint the task's full content relative to its base: merge-base plus the tree of
 * HEAD + working tree + untracked-non-ignored files, built in a temp index so the real one
 * is untouched. Committing the same content keeps the fingerprint stable.
 */
export async function computeTaskReviewFingerprint(input: {
	cwd: string;
	baseRef: string;
}): Promise<{ hasChanges: boolean; fingerprint: string }> {
	const mergeBase = await git(input.cwd, ["merge-base", "HEAD", input.baseRef]);
	const mergeBaseTree = await git(input.cwd, ["rev-parse", `${mergeBase}^{tree}`]);

	const tempDir = await mkdtemp(join(tmpdir(), "kanban-agent-review-"));
	const env = { ...createGitProcessEnv(), GIT_INDEX_FILE: join(tempDir, "index") };
	try {
		await git(input.cwd, ["read-tree", "HEAD"], { env });
		await git(input.cwd, ["add", "-A"], { env });
		const tree = await git(input.cwd, ["write-tree"], { env });
		return {
			hasChanges: tree !== mergeBaseTree,
			fingerprint: createHash("sha256").update(`${mergeBase}\n${tree}`).digest("hex"),
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

/**
 * Finds the commit on `ref` that holds exactly the content fingerprinted by computeTaskReviewFingerprint:
 * a commit whose parent is that merge-base and whose tree is that tree (e.g. the task commit cherry-picked
 * onto an unchanged base). Works without the task worktree.
 */
// ponytail: only the last 50 first-parent commits; a base that moved before the cherry-pick never matches.
export async function findCommitWithReviewFingerprint(input: {
	cwd: string;
	ref: string;
	fingerprint: string;
}): Promise<string | null> {
	const log = await git(input.cwd, ["log", "--first-parent", "-n", "50", "--format=%H %T %P", input.ref]);
	for (const line of log.split("\n")) {
		const [hash, tree, parent] = line.split(" ");
		if (
			hash &&
			tree &&
			parent &&
			createHash("sha256").update(`${parent}\n${tree}`).digest("hex") === input.fingerprint
		) {
			return hash;
		}
	}
	return null;
}
