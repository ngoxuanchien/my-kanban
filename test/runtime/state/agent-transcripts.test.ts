import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentTranscript } from "../../../src/state/agent-transcripts";

const fixtureDir = new URL("./fixtures/transcripts/", import.meta.url);
const previousHome = process.env.HOME;
let home = "";

async function prepareHome(): Promise<string> {
	home = await mkdtemp(join(tmpdir(), "agent-transcripts-home-"));
	process.env.HOME = home;
	return home;
}

afterEach(async () => {
	if (previousHome === undefined) delete process.env.HOME;
	else process.env.HOME = previousHome;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

describe("readAgentTranscript", () => {
	it.each([
		[
			"codex",
			"codex.jsonl",
			[
				{ role: "user", text: "hello" },
				{ role: "tool", text: "tool {}" },
				{ role: "assistant", text: "hi" },
			],
		],
		[
			"claude",
			"claude.jsonl",
			[
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			],
		],
		[
			"antigravity",
			"antigravity.jsonl",
			[
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "working" },
				{ role: "tool", text: 'read_file {"path":"a.ts"}' },
			],
		],
		[
			"opencode",
			"opencode.jsonl",
			[
				{ role: "user", text: "hello" },
				{ role: "assistant", text: "hi" },
			],
		],
	])("reads %s transcript turns", async (agent, fixture, expected) => {
		const dir = join(await prepareHome(), ".codex");
		await mkdir(dir, { recursive: true });
		const path = join(dir, fixture);
		await copyFile(new URL(fixture, fixtureDir), path);
		const result = await readAgentTranscript(agent, path);
		expect("unavailable" in result ? result : result.turns.map(({ role, text }) => ({ role, text }))).toEqual(
			expected,
		);
	});

	it("refuses paths outside allowed homes and reports missing files", async () => {
		const root = await prepareHome();
		const outside = join(root, "outside.jsonl");
		await writeFile(outside, "{}\n");
		expect(await readAgentTranscript("codex", outside)).toEqual({ unavailable: "path not allowed" });
		expect(await readAgentTranscript("codex", join(root, ".codex", "missing.jsonl"))).toMatchObject({
			unavailable: expect.any(String),
		});
	});

	it("returns the newest 500 turns and marks truncation", async () => {
		const dir = join(await prepareHome(), ".codex");
		await mkdir(dir, { recursive: true });
		const path = join(dir, "many.jsonl");
		await copyFile(new URL("codex-600.jsonl", fixtureDir), path);
		const result = await readAgentTranscript("codex", path);
		expect(
			"unavailable" in result
				? result
				: { count: result.turns.length, first: result.turns[0]?.text, truncated: result.truncated },
		).toEqual({
			count: 500,
			first: "turn 100",
			truncated: true,
		});
	});
});
