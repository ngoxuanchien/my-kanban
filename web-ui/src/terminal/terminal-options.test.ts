import { afterEach, describe, expect, it, vi } from "vitest";

import { getTerminalThemeColors } from "@/hooks/use-theme";
import { createKanbanTerminalOptions, openTerminalLink, parseTerminalFileLink } from "@/terminal/terminal-options";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createKanbanTerminalOptions", () => {
	it("enables richer terminal capability reporting", () => {
		const options = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			isMacPlatform: true,
			terminalBackgroundColor: "#101112",
			themeColors: getTerminalThemeColors("default"),
		});

		expect(options.allowProposedApi).toBe(true);
		expect(options.cursorBlink).toBe(false);
		expect(options.cursorInactiveStyle).toBe("outline");
		expect(options.cursorStyle).toBe("block");
		expect(options.scrollback).toBe(10_000);
		expect(options.macOptionIsMeta).toBe(true);
		expect(options.windowOptions).toEqual({
			getCellSizePixels: true,
			getWinSizeChars: true,
			getWinSizePixels: true,
		});
		expect(options.theme?.background).toBe("#101112");
		expect(options.theme?.cursor).toBe("#abcdef");
	});

	it("opens OSC 8 HTTP links without a confirmation prompt", () => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		const onFileLink = vi.fn();
		const linkHandler = createKanbanTerminalOptions({
			cursorColor: "#abcdef",
			isMacPlatform: true,
			terminalBackgroundColor: "#101112",
			themeColors: getTerminalThemeColors("default"),
			onFileLink,
		}).linkHandler;

		expect(linkHandler?.allowNonHttpProtocols).toBe(true);
		linkHandler?.activate(new MouseEvent("click"), "https://api.githubcopilot.com", {
			start: { x: 1, y: 1 },
			end: { x: 1, y: 1 },
		});

		expect(open).toHaveBeenCalledOnce();
		expect(open).toHaveBeenCalledWith("https://api.githubcopilot.com", "_blank", "noopener,noreferrer");
		expect(confirm).not.toHaveBeenCalled();
		linkHandler?.activate(new MouseEvent("click"), "file:///workspace/file.ts:12:3", {
			start: { x: 1, y: 1 },
			end: { x: 1, y: 1 },
		});
		expect(onFileLink).toHaveBeenCalledWith({ path: "/workspace/file.ts", line: 12, column: 3 });
		expect(open).toHaveBeenCalledOnce();
	});
});

describe("parseTerminalFileLink", () => {
	it.each([
		["file:///abs/path", { path: "/abs/path" }],
		["file:///abs/path:12", { path: "/abs/path", line: 12 }],
		["file:///abs/path:12:3", { path: "/abs/path", line: 12, column: 3 }],
		["file:///abs/path#L12", { path: "/abs/path", line: 12 }],
		["file:///abs/a%20b", { path: "/abs/a b" }],
	] as const)("parses %s", (uri, expected) => {
		expect(parseTerminalFileLink(uri)).toEqual(expected);
	});

	it.each(["https://example.com", "javascript:alert(1)", "not a url"])("ignores %s", (uri) => {
		expect(parseTerminalFileLink(uri)).toBeNull();
	});
});

describe("openTerminalLink", () => {
	it.each(["file:///etc/passwd", "javascript:alert(1)", "not a url"])("ignores non-HTTP or invalid URL %s", (uri) => {
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

		openTerminalLink(uri);

		expect(open).not.toHaveBeenCalled();
		expect(confirm).not.toHaveBeenCalled();
	});
});
