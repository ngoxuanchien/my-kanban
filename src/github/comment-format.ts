export const KANBAN_SYNC_MARKER = "<!-- kanban-sync -->";

function finish(body: string): string {
	return `${body}\n\n${KANBAN_SYNC_MARKER}`;
}

export function formatStatusComment(agent: string, status: string): string {
	return finish(`**Agent:** ${agent}\n**Status:** ${status}`);
}

export function formatImplementationUpdate(input: { agent: string; base: string; report: string }): string {
	const sections = input.report;
	const tests = sections.match(/### Tests\s*\n([\s\S]*?)(?=\n### |$)/);
	const report =
		tests && !tests[1]?.includes("- [ ] Code review completed")
			? sections.replace(tests[0], `${tests[0].trimEnd()}\n- [ ] Code review completed`)
			: sections;
	return finish(
		`## Implementation Update\n\n**Agent:** ${input.agent}\n**Status:** Completed\n**Base:** ${input.base}\n\n${report}`,
	);
}

export function formatDoneComment(commit?: string): string {
	return finish(`**Status:** Done${commit ? `\n**Commit:** ${commit}` : ""}`);
}
