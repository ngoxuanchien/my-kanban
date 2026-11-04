import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function findCodexModelNotFound(logText: string): "model_not_found" | null {
	let latest: "model_not_found" | null = null;
	for (const line of logText.split("\n")) {
		try {
			const event: unknown = JSON.parse(line);
			if (!event || typeof event !== "object") continue;
			const payload = (event as { payload?: unknown }).payload;
			if (!payload || typeof payload !== "object") continue;
			const task = payload as { type?: unknown; error?: { codex_error_info?: unknown } | null };
			if ((event as { type?: unknown }).type !== "event_msg" || task.type !== "task_complete") continue;
			latest = task.error?.codex_error_info === "model_not_found" ? "model_not_found" : null;
		} catch {
			// Rollout files can contain partial or malformed lines.
		}
	}
	return latest;
}

export async function readCodexModelNotFound(options: {
	worktreePath: string;
	sinceMs: number;
}): Promise<"model_not_found" | null> {
	const sessionsPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
	const files: string[] = [];
	for (const year of await readdir(sessionsPath, { withFileTypes: true }).catch(() => [])) {
		if (!year.isDirectory()) continue;
		for (const month of await readdir(join(sessionsPath, year.name), { withFileTypes: true }).catch(() => [])) {
			if (!month.isDirectory()) continue;
			for (const day of await readdir(join(sessionsPath, year.name, month.name), { withFileTypes: true }).catch(
				() => [],
			)) {
				if (day.isFile() && day.name.startsWith("rollout-") && day.name.endsWith(".jsonl"))
					files.push(join(sessionsPath, year.name, month.name, day.name));
			}
		}
	}
	const matching: Array<{ path: string; mtimeMs: number }> = [];
	for (const path of files) {
		const file = await open(path, "r").catch(() => null);
		if (!file) continue;
		try {
			const { mtimeMs, size } = await file.stat();
			if (mtimeMs < options.sinceMs) continue;
			const firstLine = Buffer.alloc(Math.min(size, 64 * 1024));
			await file.read(firstLine, 0, firstLine.length, 0);
			const meta = JSON.parse(firstLine.toString("utf8").split("\n", 1)[0] || "null") as {
				type?: string;
				payload?: { cwd?: string };
			};
			if (meta.type === "session_meta" && meta.payload?.cwd === options.worktreePath)
				matching.push({ path, mtimeMs });
		} catch {
			// Ignore malformed or concurrently changing rollout files.
		} finally {
			await file.close();
		}
	}
	matching.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const newest = matching[0];
	if (!newest) return null;
	const file = await open(newest.path, "r");
	try {
		const { size } = await file.stat();
		const length = Math.min(size, MAX_LOG_BYTES);
		const buffer = Buffer.alloc(length);
		await file.read(buffer, 0, length, size - length);
		return findCodexModelNotFound(buffer.toString("utf8"));
	} finally {
		await file.close();
	}
}
