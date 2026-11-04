import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitProcessEnv } from "../core/git-process-env";

export type GhRunner = (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile);

export const runGh: GhRunner = async (args, options) =>
	await execFileAsync("gh", args, { ...options, timeout: 30_000, encoding: "utf8" });

export async function getOriginRemoteUrl(repoPath: string): Promise<string> {
	const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
		cwd: repoPath,
		encoding: "utf8",
		env: createGitProcessEnv(),
	});
	return stdout.trim();
}
