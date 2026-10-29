export const USAGE_LIMIT_PHRASES: readonly string[] = ["Free usage limit reached", "hit your usage limit"];

export function detectUsageLimit(screenText: string): string | null {
	const escapeChar = String.fromCharCode(27);
	const recentText = screenText
		.replace(new RegExp(`${escapeChar}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\u0007]*(?:\\u0007|${escapeChar}\\\\))`, "g"), "")
		.split("\n")
		.slice(-40)
		.join("\n")
		.toLowerCase();
	return USAGE_LIMIT_PHRASES.find((phrase) => recentText.includes(phrase.toLowerCase())) ?? null;
}
