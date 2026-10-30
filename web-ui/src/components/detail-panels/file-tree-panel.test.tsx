import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileTreePanel } from "@/components/detail-panels/file-tree-panel";
import type { RuntimeWorkspaceFileChange } from "@/runtime/types";

describe("FileTreePanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("keeps file suffixes visible and exposes each full path as the row title", () => {
		const workspaceFiles: RuntimeWorkspaceFileChange[] = [
			"board-card.tsx",
			"board-card.test.tsx",
			".gitignore",
			"Makefile",
		].map((path) => ({ path, status: "modified", additions: 1, deletions: 0, oldText: "", newText: "" }));

		act(() => {
			root.render(<FileTreePanel workspaceFiles={workspaceFiles} selectedPath={null} onSelectPath={() => {}} />);
		});

		const rows = Array.from(container.querySelectorAll("button"));
		expect(rows.map((row) => row.title).sort()).toEqual([
			".gitignore",
			"Makefile",
			"board-card.test.tsx",
			"board-card.tsx",
		]);

		for (const [path, expected] of [
			["board-card.tsx", ["board-card", ".tsx"]],
			["board-card.test.tsx", ["board-card", ".test.tsx"]],
			[".gitignore", [".gitignore"]],
			["Makefile", ["Makefile"]],
		] as const) {
			const row = rows.find((candidate) => candidate.title === path);
			expect(row).toBeDefined();
			const nameWrapper = row?.querySelector(":scope > span.flex:not(.ml-auto)");
			expect(nameWrapper?.classList.contains("min-w-0")).toBe(true);
			const nameSpans = Array.from(nameWrapper?.querySelectorAll(":scope > span") ?? []);
			expect(nameSpans.map((span) => span.textContent)).toEqual(expected);
			expect(nameSpans[0]?.classList.contains("truncate")).toBe(true);
			if (expected.length === 2) {
				expect(nameSpans[1]?.classList.contains("shrink-0")).toBe(true);
				expect(nameSpans[0]?.parentElement).toBe(nameSpans[1]?.parentElement);
				expect(nameSpans[0]?.parentElement).toBe(nameWrapper);
			}
		}
	});
});
