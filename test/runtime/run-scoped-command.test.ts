import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runScopedCommand } from "../../src/server/run-scoped-command";

describe("runScopedCommand", () => {
	it("removes ELECTRON_RUN_AS_NODE without mutating the parent environment", async () => {
		const previousElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
		const cwd = await mkdtemp(join(tmpdir(), "kanban-run-scoped-command-"));
		process.env.ELECTRON_RUN_AS_NODE = "1";

		try {
			const result = await runScopedCommand("printenv ELECTRON_RUN_AS_NODE || echo unset", cwd);

			expect(result.stdout).toBe("unset");
			expect(result.exitCode).toBe(0);
			expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
		} finally {
			await rm(cwd, { recursive: true, force: true });
			if (previousElectronRunAsNode === undefined) {
				delete process.env.ELECTRON_RUN_AS_NODE;
			} else {
				process.env.ELECTRON_RUN_AS_NODE = previousElectronRunAsNode;
			}
		}
	});
});
