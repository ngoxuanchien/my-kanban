import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReviewReadyNotifications } from "@/hooks/use-review-ready-notifications";
import type { RuntimeStateStreamTaskReadyForReviewMessage } from "@/runtime/types";
import { markTabVisible } from "@/utils/tab-visibility-presence";

function Harness({
	message,
	enabled = true,
	workspacePath = "/repo/my-kanban",
}: {
	message: RuntimeStateStreamTaskReadyForReviewMessage | null;
	enabled?: boolean;
	workspacePath?: string | null;
}): null {
	useReviewReadyNotifications({
		activeWorkspaceId: "workspace-1",
		board: { columns: [], dependencies: [] },
		isDocumentVisible: false,
		latestTaskReadyForReview: message,
		taskSessions: {},
		readyForReviewNotificationsEnabled: enabled,
		workspacePath,
	});
	return null;
}

describe("useReviewReadyNotifications", () => {
	let container: HTMLDivElement;
	let root: Root;
	const notification = vi.fn((_title: string, _options?: NotificationOptions) => {});

	beforeEach(() => {
		localStorage.clear();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("Notification", Object.assign(notification, { permission: "granted" }));
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		notification.mockClear();
		container = document.createElement("div");
		root = createRoot(container);
		act(() => root.render(<Harness message={null} />));
	});

	afterEach(() => {
		act(() => root.unmount());
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		localStorage.clear();
	});

	it.each([
		{ reason: "permission" as const, workspacePath: "/repo/my-kanban", title: "my-kanban needs approval" },
		{ reason: undefined, workspacePath: "/repo/my-kanban", title: "my-kanban ready for review" },
		{ reason: "permission" as const, workspacePath: null, title: "Needs approval" },
	])("shows $title", ({ reason, workspacePath, title }) => {
		act(() =>
			root.render(
				<Harness
					workspacePath={workspacePath}
					message={{
						type: "task_ready_for_review",
						workspaceId: "workspace-1",
						taskId: "task-1",
						triggeredAt: 1,
						...(reason ? { reason } : {}),
					}}
				/>,
			),
		);
		expect(notification).toHaveBeenCalledExactlyOnceWith(title, expect.objectContaining({ body: "Task task-1" }));
	});

	it.each(["disabled", "visible", "peer"])("keeps permission notifications gated when %s", (gate) => {
		if (gate === "visible") {
			vi.mocked(document.hasFocus).mockReturnValue(true);
			vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		}
		if (gate === "peer") markTabVisible("other-tab", "workspace-1");
		act(() =>
			root.render(
				<Harness
					enabled={gate !== "disabled"}
					message={{
						type: "task_ready_for_review",
						workspaceId: "workspace-1",
						taskId: "task-1",
						triggeredAt: 1,
						reason: "permission",
					}}
				/>,
			),
		);
		expect(notification).not.toHaveBeenCalled();
	});
});
