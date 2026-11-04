import { KANBAN_SYNC_MARKER } from "./comment-format";
import type { GithubIssueReview } from "./issue-map";

const headings = ["1. Summary", "2. Acceptance Criteria Review", "3. Findings", "4. Questions", "5. Recommendations"];

export function formatIssueReview(review: GithubIssueReview, commit?: string): string {
	const body = review.body.replace(/\r\n/g, "\n");
	const status = review.status === "pass" ? "Approved" : "Changes Requested";
	const sections = headings.map((heading) => {
		const start = body.indexOf(`### ${heading}\n`);
		const content =
			start < 0
				? ""
				: body
						.slice(start + heading.length + 5)
						.split(/^### /m)[0]
						?.trim();
		return `### ${heading}\n${content || "None"}`;
	});
	const nextAction = /^\*\*Next Action:\*\*[ \t]*(.*)$/m.exec(body)?.[1]?.trim() || "None";
	const reviewer = `${review.reviewer}${review.reviewerModel ? `, model: ${review.reviewerModel}` : ""}`
		.replace(/@/g, "")
		.replace(/[\r\n]/g, " ");
	return `## Issue Review\n\n**Reviewer:** ${reviewer}\n**Review Status:** ${status}\n**Reviewed At:** ${review.reviewedAt}\n\n${sections.join("\n\n")}\n\n### 6. Final Decision\n**Status:** ${status}\n**Next Action:** ${nextAction}${review.status === "pass" && commit ? `\n**Commit:** ${commit}` : ""}\n\n${KANBAN_SYNC_MARKER}`;
}
