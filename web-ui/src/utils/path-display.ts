function normalizeDisplayPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function detectHomePrefix(path: string): string | null {
	const normalized = normalizeDisplayPath(path);
	const unixMatch = normalized.match(/^\/(?:Users|home)\/[^/]+/);
	if (unixMatch?.[0]) {
		return unixMatch[0];
	}
	const windowsMatch = normalized.match(/^[A-Za-z]:\/Users\/[^/]+/);
	if (windowsMatch?.[0]) {
		return windowsMatch[0];
	}
	return null;
}

export function formatPathForDisplay(path: string): string {
	const normalized = normalizeDisplayPath(path);
	const homePrefix = detectHomePrefix(normalized);
	if (!homePrefix) {
		return normalized;
	}
	if (normalized === homePrefix) {
		return "~";
	}
	if (normalized.startsWith(`${homePrefix}/`)) {
		return `~/${normalized.slice(homePrefix.length + 1)}`;
	}
	return normalized;
}

export function abbreviatePathSegments(path: string, abbreviatedCount: number): string {
	const normalized = normalizeDisplayPath(path);
	const driveMatch = normalized.match(/^([A-Za-z]:)\//);
	const prefix = normalized.startsWith("~/")
		? "~/"
		: normalized.startsWith("/")
			? "/"
			: driveMatch
				? `${driveMatch[1]}/`
				: "";
	const segments = normalized.slice(prefix.length).split("/").filter(Boolean);
	const lastParentIndex = Math.max(0, segments.length - 1);
	return `${prefix}${segments
		.map((segment, index) => (index < Math.min(abbreviatedCount, lastParentIndex) ? segment[0] : segment))
		.join("/")}`;
}
