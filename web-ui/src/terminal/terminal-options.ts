import type { ILinkHandler, ITerminalOptions } from "@xterm/xterm";

import type { ThemeTerminalColors } from "@/hooks/use-theme";

interface CreateKanbanTerminalOptionsInput {
	cursorColor: string;
	isMacPlatform: boolean;
	terminalBackgroundColor: string;
	themeColors: ThemeTerminalColors;
	onFileLink?: (link: { path: string; line?: number; column?: number }) => void;
}

export function parseTerminalFileLink(uri: string): { path: string; line?: number; column?: number } | null {
	if (!uri.startsWith("file://")) return null;
	const rawPath = uri.slice("file://".length);
	const lineFragment = rawPath.match(/#L(\d+)$/);
	const lineColumn = rawPath.match(/:(\d+)(?::(\d+))?$/);
	const match = lineFragment ?? lineColumn;
	const path = match ? rawPath.slice(0, match.index) : rawPath;
	try {
		const decodedPath = decodeURIComponent(path);
		if (!decodedPath.startsWith("/")) return null;
		if (lineFragment) return { path: decodedPath, line: Number(lineFragment[1]) };
		if (lineColumn)
			return {
				path: decodedPath,
				line: Number(lineColumn[1]),
				...(lineColumn[2] ? { column: Number(lineColumn[2]) } : {}),
			};
		return { path: decodedPath };
	} catch {
		return null;
	}
}

const TERMINAL_WORD_SEPARATOR = " ()[]{}',\"`";
const TERMINAL_FONT_FAMILY =
	"'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'SF Mono', Menlo, Monaco, 'Courier New', monospace";

export function openTerminalLink(uri: string): void {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return;
	}
	if (url.protocol === "http:" || url.protocol === "https:") {
		window.open(uri, "_blank", "noopener,noreferrer");
	}
}

export function createKanbanTerminalOptions({
	cursorColor,
	isMacPlatform,
	terminalBackgroundColor,
	themeColors,
	onFileLink,
}: CreateKanbanTerminalOptionsInput): ITerminalOptions {
	return {
		allowProposedApi: true,
		allowTransparency: false,
		linkHandler: {
			allowNonHttpProtocols: true,
			activate: (_event, uri) => {
				const fileLink = parseTerminalFileLink(uri);
				if (fileLink) onFileLink?.(fileLink);
				else openTerminalLink(uri);
			},
		} satisfies ILinkHandler,
		convertEol: false,
		cursorBlink: false,
		cursorInactiveStyle: "outline",
		cursorStyle: "block",
		disableStdin: false,
		fontFamily: TERMINAL_FONT_FAMILY,
		fontSize: 13,
		fontWeight: "normal",
		fontWeightBold: "bold",
		letterSpacing: 0,
		lineHeight: 1,
		macOptionClickForcesSelection: isMacPlatform,
		macOptionIsMeta: isMacPlatform,
		rightClickSelectsWord: false,
		scrollOnEraseInDisplay: true,
		scrollOnUserInput: true,
		scrollback: 10_000,
		smoothScrollDuration: 0,
		theme: {
			background: terminalBackgroundColor,
			cursor: cursorColor,
			cursorAccent: terminalBackgroundColor,
			foreground: themeColors.textPrimary,
			selectionBackground: themeColors.selectionBackground,
			selectionForeground: themeColors.selectionForeground,
			selectionInactiveBackground: themeColors.selectionInactiveBackground,
		},
		windowOptions: {
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		},
		wordSeparator: TERMINAL_WORD_SEPARATOR,
	};
}
