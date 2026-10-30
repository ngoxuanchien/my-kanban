import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { USAGE_LIMIT_PHRASES } from "./usage-limit-detector";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_FILES = 5;

export function selectNewestAntigravityLogFiles(fileNames: readonly string[]): string[] {
	return fileNames
		.filter((name) => /^cli-\d{8}_\d{6}\.log$/.test(name))
		.sort()
		.reverse()
		.slice(0, MAX_LOG_FILES);
}

export interface AntigravityLog {
	fileName: string;
	text: string;
}

function getLogTimestamp(fileName: string): number {
	const match = fileName.match(/^cli-(\d{8})_(\d{6})\.log$/);
	if (!match) return Number.NaN;
	const [, date, time] = match;
	return new Date(
		Number(date.slice(0, 4)),
		Number(date.slice(4, 6)) - 1,
		Number(date.slice(6, 8)),
		Number(time.slice(0, 2)),
		Number(time.slice(2, 4)),
		Number(time.slice(4, 6)),
	).getTime();
}

export function findAntigravityLogUsageLimit(
	logs: readonly AntigravityLog[],
	options: { worktreePath: string; sinceMs: number },
): string | null {
	for (const log of logs) {
		if (getLogTimestamp(log.fileName) < options.sinceMs - 60_000) continue;
		const lines = log.text.split("\n");
		const workspaceMatches = lines.some((line) => {
			const dirs = line.match(/workspaceDirs=\[([^\]]*)\]/)?.[1];
			return dirs ? ` ${dirs} `.includes(` ${options.worktreePath} `) : false;
		});
		if (!workspaceMatches) continue;
		for (const line of lines) {
			if (!/^E\d{4} /.test(line)) continue;
			const phrase = USAGE_LIMIT_PHRASES.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase()));
			if (phrase) return phrase;
		}
	}
	return null;
}

export async function readAntigravityLogs(): Promise<AntigravityLog[]> {
	const logDir = join(homedir(), ".gemini", "antigravity-cli", "log");
	try {
		const files = selectNewestAntigravityLogFiles(await readdir(logDir));
		const logs = await Promise.all(
			files.map(async (fileName): Promise<AntigravityLog | null> => {
				try {
					const file = await open(join(logDir, fileName), "r");
					try {
						const { size } = await file.stat();
						const length = Math.min(size, MAX_LOG_BYTES);
						const buffer = Buffer.alloc(length);
						await file.read(buffer, 0, length, size - length);
						return { fileName, text: buffer.toString("utf8") };
					} finally {
						await file.close();
					}
				} catch {
					return null;
				}
			}),
		);
		return logs.filter((log): log is AntigravityLog => log !== null);
	} catch {
		return [];
	}
}
