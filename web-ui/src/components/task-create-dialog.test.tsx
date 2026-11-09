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

describe("TaskCreateDialog edit mode and dialog sizing", () => {
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

	it("renders a large dialog (~90vw x 90vh) in both create and edit modes", async () => {
		await act(async () => {
			root.render(
				<TaskCreateDialog
					open={true}
					onOpenChange={() => {}}
					prompt="Create something"
					onPromptChange={() => {}}
					images={[]}
					onImagesChange={() => {}}
					onCreate={() => null}
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
				/>,
			);
		});

		const dialogContent = document.body.querySelector<HTMLElement>("[role='dialog']");
		expect(dialogContent?.className).toContain("w-[90vw]");
		expect(dialogContent?.className).toContain("max-w-[90vw]");
		expect(dialogContent?.className).toContain("h-[90vh]");
		expect(dialogContent?.className).toContain("max-h-[90vh]");
	});

	it("renders edit mode with title 'Edit task', prefilled prompt, and hides create-only controls", async () => {
		const onCreate = vi.fn(() => "task-1");
		const onCreateAndStart = vi.fn();
		const onOpenChange = vi.fn();

		await act(async () => {
			root.render(
				<TaskCreateDialog
					mode="edit"
					open={true}
					onOpenChange={onOpenChange}
					prompt={"1. First item\n2. Second item"}
					onPromptChange={() => {}}
					images={[]}
					onImagesChange={() => {}}
					onCreate={onCreate}
					onCreateAndStart={onCreateAndStart}
					onCreateStartAndOpen={() => null}
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
					issueSummaryEnabled={true}
					issueSummary="Some summary"
				/>,
			);
		});

		// Title should be "Edit task"
		const titleEl = document.body.querySelector("h2, [class*='font-semibold']");
		expect(titleEl?.textContent).toContain("Edit task");

		// Prompt should be prefilled
		const promptEl = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt"]');
		expect(promptEl?.value).toBe("1. First item\n2. Second item");

		// Create-only controls should be hidden:
		// 1. Split into tasks button
		expect(findButtonByText("Split into")).toBeNull();
		// 2. Create more switch
		expect(document.body.textContent).not.toContain("Create more");
		// 3. Start and open dropdown
		expect(findButtonByText("Start and open")).toBeNull();
		expect(document.body.querySelector("button[aria-label='More start options']")).toBeNull();
		// 4. Issue summary
		expect(findIssueSummaryField()).toBeNull();

		// Buttons: Save and Save & Start
		const saveButton = findButtonByText("Save");
		expect(saveButton).not.toBeNull();
		const saveAndStartButton = findButtonByText("Save & Start");
		expect(saveAndStartButton).not.toBeNull();

		// Save calls onCreate
		await act(async () => saveButton?.click());
		expect(onCreate).toHaveBeenCalledTimes(1);

		// Save & Start calls onCreateAndStart
		await act(async () => saveAndStartButton?.click());
		expect(onCreateAndStart).toHaveBeenCalledTimes(1);

		// Close calls onOpenChange(false)
		const closeButton = document.body.querySelector<SVGElement>(".lucide-x")?.closest("button");
		await act(async () => closeButton?.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});
});
