import { describe, expect, it } from "vitest";
import { formatIssueReview } from "../../../src/github/review-comment";

const body = `### 1. Summary
Reviewed changes.
### 2. Acceptance Criteria Review
- [x] Works
### 3. Findings
#### [HIGH] Missing validation
**Problem:** Invalid input accepted.
**Suggestion:** Validate it.
### 4. Questions
### 5. Recommendations
### 6. Final Decision
**Status:** Wrong
**Next Action:** Ship it.
**Commit:** untrusted`;

describe("formatIssueReview", () => {
	it.each([
		{ status: "pass" as const, reviewerModel: undefined },
		{ status: "pass" as const, reviewerModel: "opus" },
		{ status: "fail" as const, reviewerModel: undefined },
	])("formats $status with reviewer model $reviewerModel", ({ status, reviewerModel }) => {
		const decision = status === "pass" ? "Approved" : "Changes Requested";
		expect(
			formatIssueReview(
				{ id: "r1", status, reviewer: "@claude", reviewerModel, reviewedAt: "2026-11-04", body },
				"abc123",
			),
		).toBe(`## Issue Review

**Reviewer:** claude${reviewerModel ? ", model: opus" : ""}
**Review Status:** ${decision}
**Reviewed At:** 2026-11-04

### 1. Summary
Reviewed changes.

### 2. Acceptance Criteria Review
- [x] Works

### 3. Findings
#### [HIGH] Missing validation
**Problem:** Invalid input accepted.
**Suggestion:** Validate it.

### 4. Questions
None

### 5. Recommendations
None

### 6. Final Decision
**Status:** ${decision}
**Next Action:** Ship it.${status === "pass" ? "\n**Commit:** abc123" : ""}

<!-- kanban-sync -->`);
	});
	it("handles CRLF sections and leaves a blank Next Action empty", () => {
		const output = formatIssueReview({
			id: "r3",
			status: "fail",
			reviewer: "claude",
			reviewedAt: "2026-11-04",
			body: body.replace("**Next Action:** Ship it.", "**Next Action:**").replaceAll("\n", "\r\n"),
		});
		expect(output).toContain("### 1. Summary\nReviewed changes.");
		expect(output).toContain("**Next Action:** None");
		expect(output).not.toContain("untrusted");
	});

	it("formats Changes Requested without commit or any reviewer mention", () => {
		const output = formatIssueReview(
			{ id: "r2", status: "fail", reviewer: "@@bob", reviewerModel: "@opus", reviewedAt: "2026-11-04", body },
			"abc123",
		);
		expect(output).toContain("**Review Status:** Changes Requested");
		expect(output).toContain("**Status:** Changes Requested");
		expect(output).not.toContain("**Commit:**");
		expect(output.split("\n").find((line) => line.startsWith("**Reviewer:**"))).not.toContain("@");
	});
});
