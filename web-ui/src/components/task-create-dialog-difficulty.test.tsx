import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCreateDialog } from "@/components/task-create-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/hooks/use-agent-model-catalogs", () => ({
	useAgentModelCatalogs: () => ({ catalogs: null, isLoading: false, refresh: () => {} }),
}));

vi.mock("@/components/task-prompt-composer", () => ({
	TaskPromptComposer: () => null,
}));

describe("TaskCreateDialog difficulty", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		window.localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
	});

	const render = async (extra: { onDifficultyChange?: (value: 1 | 2 | 3 | 4 | 5 | undefined) => void }) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskCreateDialog
						open
						onOpenChange={() => {}}
						prompt="Task"
						onPromptChange={() => {}}
						onCreate={() => null}
						onCreateAndStart={() => null}
						onCreateStartAndOpen={() => null}
						onCreateMultiple={() => []}
						onCreateAndStartMultiple={() => []}
						images={[]}
						onImagesChange={() => {}}
						startInPlanMode={false}
						onStartInPlanModeChange={() => {}}
						autoReviewEnabled={false}
						onAutoReviewEnabledChange={() => {}}
						agentReviewEnabled={false}
						onAgentReviewEnabledChange={() => {}}
						autoReviewMode="commit"
						onAutoReviewModeChange={() => {}}
						workspaceId="workspace-1"
						branchRef="main"
						branchOptions={[{ value: "main", label: "main" }]}
						onBranchRefChange={() => {}}
						difficulty={3}
						{...extra}
					/>
				</TooltipProvider>,
			);
		});
	};

	it("reports the chosen difficulty and clears it with None", async () => {
		const onDifficultyChange = vi.fn();
		await render({ onDifficultyChange });
		const select = document.querySelector<HTMLSelectElement>('select[aria-label="Difficulty"]');
		expect(select?.value).toBe("3");
		expect(Array.from(select?.options ?? []).map((option) => option.textContent)).toEqual([
			"None",
			"1",
			"2",
			"3",
			"4",
			"5",
		]);
		await act(async () => {
			if (select) {
				select.value = "5";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(onDifficultyChange).toHaveBeenLastCalledWith(5);
		await act(async () => {
			if (select) {
				select.value = "";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(onDifficultyChange).toHaveBeenLastCalledWith(undefined);
	});

	it("hides the selector when no change handler is passed", async () => {
		await render({});
		expect(document.querySelector('select[aria-label="Difficulty"]')).toBeNull();
	});
});
