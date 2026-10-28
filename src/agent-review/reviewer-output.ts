import { type RuntimeAgentReviewResult, runtimeAgentReviewResultSchema } from "../core/api-contract";

export type ParsedReviewerVerdict = { ok: true; result: RuntimeAgentReviewResult } | { ok: false; error: string };

/** Parses the verdict file the reviewer wrote; null means the file does not exist. */
export function parseReviewerVerdict(content: string | null): ParsedReviewerVerdict {
	if (content === null) {
		return { ok: false, error: "reviewer did not write the verdict file" };
	}

	let json = content.trim();
	const fence = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	if (fence) json = fence[1] ?? "";

	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { ok: false, error: "verdict file contains invalid JSON" };
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
