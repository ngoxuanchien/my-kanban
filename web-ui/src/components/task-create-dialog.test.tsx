import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskCreateDialog } from "@/components/task-create-dialog";

vi.mock("@/components/task-agent-model-picker", () => ({
	TaskAgentModelPicker: () => null,
	useTaskAgentModelPicker: () => ({}),
}));

vi.mock("@/components/task-prompt-composer", () => ({
	TaskPromptComposer: ({ value }: { value: string }) => <textarea aria-label="Prompt" value={value} readOnly />,
}));

function findButtonByText(text: string): HTMLButtonElement | null {
	return (Array.from(document.body.querySelectorAll("button")).find((button) =>
		button.textContent?.trim().startsWith(text),
	) ?? null) as HTMLButtonElement | null;
}

function findIssueSummaryField(): HTMLTextAreaElement | null {
	return document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Issue summary"]');
}

describe("TaskCreateDialog issue summary", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.clear();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		document.body.innerHTML = "";
	});

	async function renderDialog(options: {
		issueSummaryEnabled: boolean;
		prompt?: string;
		onIssueSummaryChange?: (value: string) => void;
	}): Promise<void> {
		await act(async () => {
			root.render(
				<TaskCreateDialog
					open={true}
					onOpenChange={() => {}}
					prompt={options.prompt ?? "Fix the login bug"}
					onPromptChange={() => {}}
					images={[]}
					onImagesChange={() => {}}
					onCreate={() => null}
					onCreateMultiple={() => []}
					startInPlanMode={false}
					onStartInPlanModeChange={() => {}}
					autoReviewEnabled={false}
					onAutoReviewEnabledChange={() => {}}
					agentReviewEnabled={true}
					onAgentReviewEnabledChange={() => {}}
					autoReviewMode="commit"
					onAutoReviewModeChange={() => {}}
					workspaceId="workspace-1"
					branchRef="main"
					branchOptions={[{ value: "main", label: "main" }]}
					onBranchRefChange={() => {}}
					issueSummaryEnabled={options.issueSummaryEnabled}
					issueSummary=""
					onIssueSummaryChange={options.onIssueSummaryChange ?? (() => {})}
				/>,
			);
		});
	}

	it("hides the issue summary field when sync is off", async () => {
		await renderDialog({ issueSummaryEnabled: false });
		expect(findIssueSummaryField()).toBeNull();
	});

	it("shows the issue summary field when sync is on and reports edits", async () => {
		const onIssueSummaryChange = vi.fn();
		await renderDialog({ issueSummaryEnabled: true, onIssueSummaryChange });
		const field = findIssueSummaryField();
		expect(field).not.toBeNull();

		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setValue?.call(field, "Users cannot log in.");
			field?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(onIssueSummaryChange).toHaveBeenCalledWith("Users cannot log in.");
	});

	it("hides the issue summary field in multi-task mode", async () => {
		await renderDialog({ issueSummaryEnabled: true, prompt: "1. First task\n2. Second task" });
		expect(findIssueSummaryField()).not.toBeNull();

		await act(async () => findButtonByText("Split into 2 tasks")?.click());

		expect(findIssueSummaryField()).toBeNull();
	});
});
