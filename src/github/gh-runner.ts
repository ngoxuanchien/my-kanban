import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type GhRunner = (args: string[], options: { cwd: string }) => Promise<{ stdout: string }>;
const execFileAsync = promisify(execFile);

export const runGh: GhRunner = async (args, options) =>
	await execFileAsync("gh", args, { ...options, timeout: 30_000, encoding: "utf8" });
