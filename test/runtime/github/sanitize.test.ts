import { expect, it } from "vitest";
import { sanitizeForGithub } from "../../../src/github/sanitize";

it("replaces internal paths while keeping repository paths", () => {
	expect(
		sanitizeForGithub("contexte/foo.md /Users/a/b /home/a/b ~/x/y .cline/worktrees/1 src/github/issue-sync.ts"),
	).toBe("[internal path] [internal path] [internal path] [internal path] [internal path] src/github/issue-sync.ts");
	expect(sanitizeForGithub("`/Users/a` (contexte/x) .cline/a, docs/a.md and ~/b")).toBe(
		"`[internal path]` ([internal path]) [internal path] docs/a.md and [internal path]",
	);
});
