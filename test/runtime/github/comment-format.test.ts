import { expect, it } from "vitest";
import {
	formatDoneComment,
	formatImplementationUpdate,
	formatStatusComment,
	KANBAN_SYNC_MARKER,
} from "../../../src/github/comment-format";

it("formats status and done comments with the sync marker", () => {
	expect(formatStatusComment("codex, model: gpt-6-sol", "In Progress")).toBe(
		`**Agent:** codex, model: gpt-6-sol\n**Status:** In Progress\n\n${KANBAN_SYNC_MARKER}`,
	);
	expect(formatDoneComment()).toContain("**Status:** Done");
	expect(formatDoneComment("abc123")).toContain("**Commit:** abc123");
});

it("fills report metadata and appends the review checkbox once", () => {
	const report =
		"### Summary\nDone\n\n### Changes\nCode\n\n### Tests\nPassed\n\n### References\nNone\n\n### Next Steps\nNone";
	const formatted = formatImplementationUpdate({ agent: "codex", base: "main", report });
	expect(formatted).toContain("**Base:** main");
	expect(formatted.match(/- \[ \] Code review completed/g)).toHaveLength(1);
	expect(formatted).not.toContain("Branch:");
	expect(formatted).not.toContain("PR:");
	expect(
		formatImplementationUpdate({
			agent: "codex",
			base: "main",
			report: report.replace("### Tests\nPassed", "### Tests\nPassed\n- [ ] Code review completed"),
		}).match(/- \[ \] Code review completed/g),
	).toHaveLength(1);
	expect(formatted.endsWith(KANBAN_SYNC_MARKER)).toBe(true);
});
