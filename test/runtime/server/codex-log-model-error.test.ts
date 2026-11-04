import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCodexModelNotFound, readCodexModelNotFound } from "../../../src/server/codex-log-model-error";

const roots: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;

afterEach(async () => {
	process.env.CODEX_HOME = originalCodexHome;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rollout(cwd: string, text: string, modifiedAt = Date.now()) {
	const root = await mkdtemp(join(tmpdir(), "codex-rollout-test-"));
	roots.push(root);
	process.env.CODEX_HOME = root;
	const directory = join(root, "sessions", "2026", "11", "04");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "rollout-test.jsonl");
	await writeFile(path, `{"type":"session_meta","payload":{"cwd":${JSON.stringify(cwd)}}}\n${text}`);
	await utimes(path, modifiedAt / 1000, modifiedAt / 1000);
	return path;
}

const failed = '{"type":"event_msg","payload":{"type":"task_complete","error":{"codex_error_info":"model_not_found"}}}';
const succeeded = '{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}';

describe("Codex model_not_found rollout detection", () => {
	it("detects the latest failed task_complete", () => {
		expect(findCodexModelNotFound(`${failed}\n`)).toBe("model_not_found");
	});

	it("ignores malformed lines", () => {
		expect(findCodexModelNotFound(`not json\n${failed}\n{`)).toBe("model_not_found");
	});

	it("requires the matching cwd", async () => {
		await rollout("/other/worktree", failed);
		expect(await readCodexModelNotFound({ worktreePath: "/worktree/task-1", sinceMs: 0 })).toBeNull();
	});

	it("ignores rollout files older than the session", async () => {
		await rollout("/worktree/task-1", failed, 1_000);
		expect(await readCodexModelNotFound({ worktreePath: "/worktree/task-1", sinceMs: 2_000 })).toBeNull();
	});

	it("clears the failure after a later successful task_complete", async () => {
		await rollout("/worktree/task-1", `${failed}\n${succeeded}`);
		expect(await readCodexModelNotFound({ worktreePath: "/worktree/task-1", sinceMs: 0 })).toBeNull();
	});
});
