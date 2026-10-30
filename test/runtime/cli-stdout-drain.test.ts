import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("drainCliOutput", () => {
	it("flushes output larger than a pipe buffer before exit", () => {
		const outputLength = 200_000;
		const childScript = `
			import { drainCliOutput } from "./src/cli-stdout-drain.ts";
			process.stdout.write("a".repeat(${outputLength}));
			await drainCliOutput();
			process.exit(0);
		`;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
				encoding: "buffer",
			});

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout.byteLength).toBe(outputLength);
		}
	});
});
