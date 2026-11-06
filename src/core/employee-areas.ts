export const EMPLOYEE_AREAS = [
	"web-ui",
	"desktop",
	"issue-sync",
	"terminal",
	"cli",
	"state",
	"server",
	"cline-sdk",
	"runtime-other",
	"docs",
	"tests",
] as const;

export type EmployeeArea = (typeof EMPLOYEE_AREAS)[number];

export function isEmployeeArea(value: string): value is EmployeeArea {
	return (EMPLOYEE_AREAS as readonly string[]).includes(value);
}

function areaOfFile(path: string): EmployeeArea | null {
	if (path.startsWith("web-ui/")) return "web-ui";
	if (path.startsWith("packages/desktop/")) return "desktop";
	if (path.includes("github-issue") || path.includes("issue-sync")) return "issue-sync";
	if (path.startsWith("src/terminal/")) return "terminal";
	if (path.startsWith("src/commands/") || path === "src/cli.ts") return "cli";
	if (path.startsWith("src/state/") || path.startsWith("src/fs/")) return "state";
	if (path.startsWith("src/server/") || path.startsWith("src/trpc/")) return "server";
	if (path.startsWith("src/cline-sdk/")) return "cline-sdk";
	if (path.startsWith("src/")) return "runtime-other";
	if (path.startsWith("docs/") || path.endsWith(".md")) return "docs";
	if (path.startsWith("test/")) return "tests";
	return null;
}

export function areasOfFiles(paths: string[]): EmployeeArea[] {
	const found = new Set<EmployeeArea>();
	for (const path of paths) {
		const area = areaOfFile(path);
		if (area) found.add(area);
	}
	// "tests" counts only when the task matched no other area.
	if (found.size > 1) found.delete("tests");
	return EMPLOYEE_AREAS.filter((area) => found.has(area));
}
