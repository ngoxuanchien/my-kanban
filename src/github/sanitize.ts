export function sanitizeForGithub(text: string): string {
	return text.replace(/(?:contexte\/|\.cline\/|~\/|\/Users\/|\/home\/)[^\s`"'\])}]*/g, "[internal path]");
}
