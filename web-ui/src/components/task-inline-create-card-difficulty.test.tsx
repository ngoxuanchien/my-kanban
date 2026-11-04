import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskInlineCreateCard } from "@/components/task-inline-create-card";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/hooks/use-agent-model-catalogs", () => ({
	useAgentModelCatalogs: () => ({ catalogs: null, isLoading: false, refresh: () => {} }),
}));

vi.mock("@/components/task-prompt-composer", () => ({
	TaskPromptComposer: () => null,
}));

describe("TaskInlineCreateCard difficulty (edit surface)", () => {
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

	const render = async (extra: { onDifficultyChange?: (value: 1 | 2 | 3 | 4 | 5 | undefined) => void }) => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskInlineCreateCard
						mode="edit"
						prompt="Task"
						onPromptChange={() => {}}
						onCreate={() => {}}
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
						difficulty={2}
						{...extra}
					/>
				</TooltipProvider>,
			);
		});
	};

	it("renders the difficulty select with the task value and reports changes", async () => {
		const onDifficultyChange = vi.fn();
		await render({ onDifficultyChange });
		const select = document.querySelector<HTMLSelectElement>('select[aria-label="Difficulty"]');
		expect(select?.value).toBe("2");
		await act(async () => {
			if (select) {
				select.value = "4";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			}
		});
		expect(onDifficultyChange).toHaveBeenLastCalledWith(4);
	});

	it("hides the selector when no change handler is passed", async () => {
		await render({});
		expect(document.querySelector('select[aria-label="Difficulty"]')).toBeNull();
	});
});
