import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));

// No test runs the real codex/opencode.
vi.mock("node:child_process", () => ({ execFile: childProcessMocks.execFile }));

import {
	loadAgentModelCatalog,
	parseCodexModelCatalog,
	parseOpenCodeModelCatalog,
} from "../../../src/terminal/agent-model-catalog";

const fixturesDir = join(__dirname, "..", "..", "fixtures");
const codexFixture = readFileSync(join(fixturesDir, "codex-debug-models.json"), "utf8");
const opencodeFixture = readFileSync(join(fixturesDir, "opencode-models.txt"), "utf8");

describe("parseCodexModelCatalog", () => {
	it("keeps only visibility list entries with their efforts", () => {
		const catalog = parseCodexModelCatalog(codexFixture);
		if (!catalog.ok) throw new Error(catalog.error);
		expect(catalog.models.map((model) => model.id)).toEqual(["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"]);
		const luna = catalog.models.find((model) => model.id === "gpt-6-luna");
		expect(luna).toEqual({
			id: "gpt-6-luna",
			displayName: "GPT-6-Luna",
			description: "Fast and affordable model for easier tasks.",
			efforts: ["low", "medium", "high", "xhigh", "max"],
			defaultEffort: "medium",
		});
		expect(luna?.efforts).not.toContain("ultra");
		expect(catalog.models.find((model) => model.id === "gpt-5.6-terra")?.efforts).toContain("ultra");
	});

	it("returns ok:false for invalid JSON or an unexpected shape", () => {
		expect(parseCodexModelCatalog("Error: not logged in").ok).toBe(false);
		expect(parseCodexModelCatalog('{"items":[]}').ok).toBe(false);
	});
});

describe("parseOpenCodeModelCatalog", () => {
	it("reads one provider/model id per line", () => {
		const catalog = parseOpenCodeModelCatalog(opencodeFixture);
		if (!catalog.ok) throw new Error(catalog.error);
		expect(catalog.models).toHaveLength(9);
		expect(catalog.models[0]).toEqual({ id: "opencode/beam-free", efforts: [] });
	});

	it("returns ok:false for empty output", () => {
		expect(parseOpenCodeModelCatalog("\n").ok).toBe(false);
	});
});

describe("loadAgentModelCatalog", () => {
	beforeEach(() => {
		childProcessMocks.execFile.mockReset();
	});

	it("returns the claude aliases without running a command", async () => {
		const catalog = await loadAgentModelCatalog("claude");
		expect(catalog).toEqual({
			ok: true,
			models: [
				{ id: "haiku", efforts: [] },
				{ id: "sonnet", efforts: [] },
				{ id: "opus", efforts: [] },
			],
		});
		expect(childProcessMocks.execFile).not.toHaveBeenCalled();
	});

	it("runs codex debug models without a shell and caches until refresh", async () => {
		childProcessMocks.execFile.mockImplementation(
			(_file: string, _args: string[], _options: object, callback: (error: null, out: { stdout: string }) => void) =>
				callback(null, { stdout: codexFixture }),
		);
		const first = await loadAgentModelCatalog("codex", { refresh: true });
		expect(first.ok).toBe(true);
		expect(childProcessMocks.execFile).toHaveBeenCalledWith(
			"codex",
			["debug", "models"],
			expect.objectContaining({ encoding: "utf8" }),
			expect.any(Function),
		);
		await loadAgentModelCatalog("codex");
		expect(childProcessMocks.execFile).toHaveBeenCalledTimes(1);
		await loadAgentModelCatalog("codex", { refresh: true });
		expect(childProcessMocks.execFile).toHaveBeenCalledTimes(2);
	});

	it("returns ok:false when the command exits non-zero", async () => {
		childProcessMocks.execFile.mockImplementation(
			(_file: string, _args: string[], _options: object, callback: (error: Error) => void) =>
				callback(new Error("exit code 1")),
		);
		const catalog = await loadAgentModelCatalog("opencode", { refresh: true });
		expect(catalog).toEqual({ ok: false, error: "opencode models failed: exit code 1" });
	});
});
