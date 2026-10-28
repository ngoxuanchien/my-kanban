import { type RuntimeAgentReviewResult, runtimeAgentReviewResultSchema } from "../core/api-contract";

export const AGENT_REVIEW_RESULT_START = "<<<KANBAN_AGENT_REVIEW_RESULT";
export const AGENT_REVIEW_RESULT_END = "KANBAN_AGENT_REVIEW_RESULT>>>";

export type ParsedReviewerOutput = { ok: true; result: RuntimeAgentReviewResult } | { ok: false; error: string };

export function parseReviewerOutput(output: string): ParsedReviewerOutput {
	const start = output.lastIndexOf(AGENT_REVIEW_RESULT_START);
	if (start < 0) {
		return { ok: false, error: "no result block found" };
	}

	const contentStart = start + AGENT_REVIEW_RESULT_START.length;
	const end = output.indexOf(AGENT_REVIEW_RESULT_END, contentStart);
	if (end < 0) {
		return { ok: false, error: "result block has no end marker" };
	}

	let json = output.slice(contentStart, end).trim();
	const fence = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence) json = fence[1] ?? "";

	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { ok: false, error: "result block contains invalid JSON" };
	}

	const parsed = runtimeAgentReviewResultSchema.safeParse(value);
	if (!parsed.success) {
		return { ok: false, error: `invalid result shape: ${parsed.error.message}` };
	}
	if (parsed.data.verdict === "pass" && parsed.data.summary === null) {
		return { ok: false, error: "pass result requires a summary" };
	}
	if (parsed.data.verdict === "fail" && !parsed.data.fixPrompt?.trim()) {
		return { ok: false, error: "fail result requires a fixPrompt" };
	}
	return { ok: true, result: parsed.data };
}
