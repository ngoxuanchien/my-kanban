import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskPromptComposer } from "@/components/task-prompt-composer";

describe("TaskPromptComposer sizing", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
	});

	it("uses default minHeight of 80 and maxHeight cap of 200 by default", async () => {
		await act(async () => {
			root.render(<TaskPromptComposer value="A short task" onValueChange={() => {}} />);
		});

		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		expect(textarea).not.toBeNull();
		expect(textarea?.style.minHeight).toBe("80px");
		expect(textarea?.style.maxHeight).toBe("200px");
	});

	it("lifts the 200px cap and uses tall minHeight when tall is true", async () => {
		await act(async () => {
			root.render(<TaskPromptComposer value="A large prompt inside dialog" onValueChange={() => {}} tall />);
		});

		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		expect(textarea).not.toBeNull();
		expect(textarea?.style.minHeight).toBe("320px");
		// Uncapped maxHeight: style.maxHeight should be empty / undefined
		expect(textarea?.style.maxHeight).toBe("");
	});
});
