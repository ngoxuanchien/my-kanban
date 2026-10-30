import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { USAGE_LIMIT_PHRASES } from "./usage-limit-detector";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function findOpenCodeLogUsageLimit(
	logText: string,
	options: { worktreePath: string; sinceMs: number },
): string | null {
	const linkedRuns = new Set<string>();
	const lines = logText.split("\n");
	for (const line of lines) {
		const run = line.match(/(?:^|\s)run=([^\s]+)/)?.[1];
		const directory = line
			.match(/(?:^|\s)directory=(?:"([^"]+)"|(\S+))/)
			?.slice(1)
			.find(Boolean);
		if (run && directory === options.worktreePath) linkedRuns.add(run);
	}
	for (const line of lines) {
		if (!/(?:^|\s)level=ERROR(?:\s|$)/.test(line)) continue;
		const run = line.match(/(?:^|\s)run=([^\s]+)/)?.[1];
		const timestamp = line.match(/(?:^|\s)timestamp=([^\s]+)/)?.[1];
		const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
		if (!run || !linkedRuns.has(run) || !Number.isFinite(timestampMs) || timestampMs < options.sinceMs) continue;
		const phrase = USAGE_LIMIT_PHRASES.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase()));
		if (phrase) return phrase;
	}
	return null;
}

export async function readOpenCodeLogTail(): Promise<string | null> {
	const path = join(
		process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
		"opencode",
		"log",
		"opencode.log",
	);
	try {
		const file = await open(path, "r");
		try {
			const { size } = await file.stat();
			const length = Math.min(size, MAX_LOG_BYTES);
			const buffer = Buffer.alloc(length);
			await file.read(buffer, 0, length, size - length);
			return buffer.toString("utf8");
		} finally {
			await file.close();
		}
	} catch {
		return null;
	}
}
