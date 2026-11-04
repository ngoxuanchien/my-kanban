import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DifficultyModelTable } from "@/components/difficulty-model-table";
import type { RuntimeAgentModelCatalogsResponse } from "@/runtime/types";
import { DEFAULT_DIFFICULTY_MODEL_MAP } from "../../../src/core/agent-model";

const catalogs: RuntimeAgentModelCatalogsResponse = {
	codex: {
		ok: true,
		models: [
			{ id: "gpt-6-luna", efforts: ["low", "medium"] },
			{ id: "gpt-6.1-sol", efforts: ["medium", "high"] },
			{ id: "gpt-6-astra", efforts: ["high"] },
		],
	},
	opencode: { ok: true, models: [{ id: "zen/free", efforts: [] }] },
	claude: { ok: true, models: [] },
};

function changeSelect(select: HTMLSelectElement | null, value: string): void {
	if (!select) {
		throw new Error("Select not found");
	}
	select.value = value;
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("DifficultyModelTable", () => {
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
	});

	const render = async (onChange = vi.fn(), overrides: Partial<RuntimeAgentModelCatalogsResponse> = {}) => {
		await act(async () => {
			root.render(
				<DifficultyModelTable
					value={DEFAULT_DIFFICULTY_MODEL_MAP}
					catalogs={{ ...catalogs, ...overrides }}
					onChange={onChange}
				/>,
			);
		});
		return onChange;
	};

	const select = (label: string) => container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);

	it("renders rows 1-5 and codex, opencode, claude columns", async () => {
		await render();
		expect(Array.from(container.querySelectorAll("thead th")).map((cell) => cell.textContent)).toEqual([
			"Difficulty",
			"Codex",
			"OpenCode",
			"Claude",
		]);
		expect(Array.from(container.querySelectorAll("tbody th")).map((cell) => cell.textContent)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
		expect(select("Codex model for difficulty 3")?.value).toBe("gpt-6.1-sol");
		expect(select("Codex effort for difficulty 3")?.value).toBe("medium");
		expect(select("OpenCode model for difficulty 3")?.value).toBe("");
		expect(select("Claude model for difficulty 5")?.value).toBe("opus");
	});

	it("reports edits as a new map", async () => {
		const onChange = await render();
		await act(async () => changeSelect(select("OpenCode model for difficulty 2"), "zen/free"));
		expect(onChange.mock.lastCall?.[0].opencode).toEqual({ 2: { model: "zen/free" } });

		await act(async () => changeSelect(select("Claude model for difficulty 1"), "opus"));
		expect(onChange.mock.lastCall?.[0].claude?.[1]).toEqual({ model: "opus" });

		await act(async () => changeSelect(select("Codex effort for difficulty 3"), "high"));
		expect(onChange.mock.lastCall?.[0].codex?.[3]).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high" });
	});

	it("limits effort options to the model and drops an unsupported effort on model change", async () => {
		const onChange = await render();
		expect(Array.from(select("Codex effort for difficulty 3")?.options ?? []).map((option) => option.value)).toEqual([
			"",
			"medium",
			"high",
		]);
		await act(async () => changeSelect(select("Codex model for difficulty 3"), "gpt-6-astra"));
		expect(onChange.mock.lastCall?.[0].codex?.[3]).toEqual({ model: "gpt-6-astra" });
	});

	it("Default clears the cell", async () => {
		const onChange = await render();
		await act(async () => changeSelect(select("Codex model for difficulty 3"), ""));
		expect(onChange.mock.lastCall?.[0].codex?.[3]).toBeUndefined();
		await act(async () => changeSelect(select("Claude model for difficulty 5"), ""));
		expect(onChange.mock.lastCall?.[0].claude?.[5]).toBeUndefined();
	});

	it("falls back to free text when the catalog is unavailable", async () => {
		const onChange = await render(vi.fn(), { codex: { ok: false, error: "no codex" } });
		const input = container.querySelector<HTMLInputElement>('input[aria-label="Codex model for difficulty 3"]');
		expect(input?.value).toBe("gpt-6.1-sol");
		const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		await act(async () => {
			setValue?.call(input, "custom-model");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onChange.mock.lastCall?.[0].codex?.[3]?.model).toBe("custom-model");
	});
});
