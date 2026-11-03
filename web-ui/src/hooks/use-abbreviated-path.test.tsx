import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAbbreviatedPath } from "@/hooks/use-abbreviated-path";

const path = "~/Documents/HCMUT/Advanced/ASA-CO5260";

describe("useAbbreviatedPath", () => {
	let container: HTMLDivElement;
	let root: Root;
	let width = 400;
	let fractionalPathWidth: number | undefined;
	let resize: (() => void) | undefined;
	let previousClientWidth: PropertyDescriptor | undefined;
	let previousRect: PropertyDescriptor | undefined;
	let previousResizeObserver: PropertyDescriptor | undefined;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		width = 400;
		previousClientWidth = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientWidth");
		previousRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "getBoundingClientRect");
		previousResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
		Object.defineProperty(HTMLDivElement.prototype, "clientWidth", { configurable: true, get: () => width });
		Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
			configurable: true,
			value(this: HTMLElement) {
				const spanWidth =
					this.textContent === path
						? (fractionalPathWidth ?? path.length * 8)
						: (this.textContent?.length ?? 0) * 8;
				return { width: this.tagName === "SPAN" ? spanWidth : width } as DOMRect;
			},
		});
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resize = callback;
				}
				observe() {}
				disconnect() {}
			},
		);
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousClientWidth) Object.defineProperty(HTMLDivElement.prototype, "clientWidth", previousClientWidth);
		else Reflect.deleteProperty(HTMLDivElement.prototype, "clientWidth");
		if (previousRect) Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", previousRect);
		else Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
		if (previousResizeObserver) Object.defineProperty(globalThis, "ResizeObserver", previousResizeObserver);
		else Reflect.deleteProperty(globalThis, "ResizeObserver");
		vi.unstubAllGlobals();
		resize = undefined;
		fractionalPathWidth = undefined;
	});

	it("re-abbreviates when space shrinks and restores the full path when it grows", () => {
		function Path({ attached }: { attached: boolean }) {
			const { pathRef, displayPath, fullPathWidth } = useAbbreviatedPath(path);
			return attached ? (
				<div ref={pathRef} data-full-path-width={fullPathWidth}>
					{displayPath}
				</div>
			) : null;
		}

		act(() => root.render(<Path attached={false} />));
		act(() => root.render(<Path attached />));
		expect(container.firstElementChild?.getAttribute("data-full-path-width")).toBe(String(path.length * 8 + 1));
		width = 170;
		act(() => resize?.());
		expect(container.textContent).toBe("~/D/H/A/ASA-CO5260");

		width = 400;
		act(() => resize?.());
		expect(container.textContent).toBe(path);
	});

	it("rounds fractional path measurements up and does not treat fractional pixels as a fit", () => {
		function Path() {
			const { pathRef, displayPath, fullPathWidth } = useAbbreviatedPath(path);
			return (
				<div ref={pathRef} data-full-path-width={fullPathWidth}>
					{displayPath}
				</div>
			);
		}

		fractionalPathWidth = 216.742;
		width = 216.742;
		act(() => root.render(<Path />));

		expect(Number(container.firstElementChild?.getAttribute("data-full-path-width"))).toBeGreaterThanOrEqual(218);
		width = 216.9;
		act(() => resize?.());
		expect(container.textContent).not.toBe(path);
	});
});
