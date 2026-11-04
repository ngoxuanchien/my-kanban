import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGithubIssue, useGithubIssues } from "@/hooks/use-github-issues";
import type { RuntimeGithubIssuesResponse, RuntimeWorkspaceStateResponse } from "@/runtime/types";

const getGithubIssuesQueryMock = vi.hoisted(() => vi.fn<() => Promise<RuntimeGithubIssuesResponse>>());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({ workspace: { getGithubIssues: { query: getGithubIssuesQueryMock } } }),
}));

function IssueLabel({ taskId }: { taskId: string }): React.ReactElement {
	const issue = useGithubIssue(taskId);
	return <span data-testid="issue">{issue ? `#${issue.number}` : "none"}</span>;
}

function Harness({ workspaceState }: { workspaceState: RuntimeWorkspaceStateResponse | null }): React.ReactElement {
	useGithubIssues("workspace-1", workspaceState);
	return <IssueLabel taskId="task-1" />;
}

function workspaceState(): RuntimeWorkspaceStateResponse {
	return {} as RuntimeWorkspaceStateResponse;
}

describe("useGithubIssues", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		getGithubIssuesQueryMock.mockReset();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
	});

	it("refetches on each workspace state update and exposes the issue to cards", async () => {
		getGithubIssuesQueryMock.mockResolvedValue({ enabled: true, issues: {} });
		await act(async () => {
			root.render(<Harness workspaceState={null} />);
		});
		expect(container.textContent).toBe("none");
		const callsBeforeUpdate = getGithubIssuesQueryMock.mock.calls.length;

		getGithubIssuesQueryMock.mockResolvedValue({
			enabled: true,
			issues: { "task-1": { number: 12, url: "https://github.com/acme/repo/issues/12" } },
		});
		await act(async () => {
			root.render(<Harness workspaceState={workspaceState()} />);
		});

		expect(getGithubIssuesQueryMock.mock.calls.length).toBe(callsBeforeUpdate + 1);
		expect(container.textContent).toBe("#12");
	});
});
