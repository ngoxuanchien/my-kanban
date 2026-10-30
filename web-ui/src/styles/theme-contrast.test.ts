import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GLOBALS_CSS_PATH = resolve(process.cwd(), "src", "styles", "globals.css");
const MIN_CONTRAST_RATIO = 4.5;

function parseDefaultThemeTokens(css: string): Map<string, string> {
	const themeBlock = css.match(/@theme\s*\{([\s\S]*?)\n\}/u);
	if (!themeBlock?.[1]) {
		throw new Error("Could not find the default @theme block in globals.css");
	}

	const tokens = new Map<string, string>();
	for (const match of themeBlock[1].matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/gu)) {
		const [, name, value] = match;
		if (name && value) {
			tokens.set(name, value);
		}
	}
	return tokens;
}

function channelToLinear(channel: number): number {
	const normalized = channel / 255;
	return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string): number {
	const hex = hexColor.replace("#", "");
	const [red, green, blue] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
	if (red === undefined || green === undefined || blue === undefined) {
		throw new Error(`Invalid hex color: ${hexColor}`);
	}
	return 0.2126 * channelToLinear(red) + 0.7152 * channelToLinear(green) + 0.0722 * channelToLinear(blue);
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	const lighter = Math.max(foregroundLuminance, backgroundLuminance);
	const darker = Math.min(foregroundLuminance, backgroundLuminance);
	return (lighter + 0.05) / (darker + 0.05);
}

const tokens = parseDefaultThemeTokens(readFileSync(GLOBALS_CSS_PATH, "utf8"));

const SURFACE_TOKEN_NAMES = ["color-surface-0", "color-surface-1", "color-surface-2"] as const;
const TEXT_TOKEN_NAMES = ["color-text-secondary", "color-text-tertiary"] as const;

function readToken(name: string): string {
	const value = tokens.get(name);
	if (!value) {
		throw new Error(`Missing --${name} in the default @theme block`);
	}
	return value;
}

describe("default theme text contrast", () => {
	it("parses the expected default surface tokens", () => {
		expect(readToken("color-surface-0")).toBe("#1F2428");
		expect(readToken("color-surface-1")).toBe("#24292E");
		expect(readToken("color-surface-2")).toBe("#2D3339");
	});

	it.each(TEXT_TOKEN_NAMES)("%s reaches WCAG AA contrast on surfaces 0-2", (textTokenName) => {
		const foreground = readToken(textTokenName);
		for (const surfaceTokenName of SURFACE_TOKEN_NAMES) {
			const background = readToken(surfaceTokenName);
			const ratio = contrastRatio(foreground, background);
			expect(
				ratio,
				`--${textTokenName} (${foreground}) on --${surfaceTokenName} (${background}) is ${ratio.toFixed(2)}:1`,
			).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
		}
	});

	it("keeps text-secondary brighter than text-tertiary", () => {
		expect(relativeLuminance(readToken("color-text-secondary"))).toBeGreaterThan(
			relativeLuminance(readToken("color-text-tertiary")),
		);
	});
});
