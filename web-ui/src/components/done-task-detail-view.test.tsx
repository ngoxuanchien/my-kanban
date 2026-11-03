import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DoneTaskDetailView } from "@/components/done-task-detail-view";
import type { RuntimeTaskHistoryEvent } from "@/runtime/types";
import type { BoardCard, CardSelection } from "@/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetTaskHistoryQuery = vi.hoisted(() => vi.fn());
const mockGetCommitChangesQuery = vi.hoisted(() => vi.fn());
const mockGetTaskPatchChangesQuery = vi.hoisted(() => vi.fn());
const mockGetAgentTranscriptQuery = vi.hoisted(() => vi.fn());
const mockStartTaskSessionMutate = vi.hoisted(() => vi.fn());

vi.mock("@/runtime/trpc-client", () => ({
	getRuntimeTrpcClient: () => ({
		workspace: {
			getTaskHistory: {
				query: mockGetTaskHistoryQuery,
			},
			getCommitChanges: {
				query: mockGetCommitChangesQuery,
			},
			getTaskPatchChanges: {
				query: mockGetTaskPatchChangesQuery,
			},
			getAgentTranscript: {
				query: mockGetAgentTranscriptQuery,
			},
		},
		runtime: {
			startTaskSession: {
				mutate: mockStartTaskSessionMutate,
			},
		},
	}),
}));

vi.mock("@/components/detail-panels/diff-viewer-panel", () => ({
	DiffViewerPanel: ({ workspaceFiles }: { workspaceFiles: unknown[] | null }) => (
		<div data-testid="mock-diff-viewer-panel">Files: {workspaceFiles ? workspaceFiles.length : 0}</div>
	),
}));

function createCard(overrides: Partial<BoardCard> = {}): BoardCard {
	return {
		id: "done-task-1",
		title: "Ship Done Card History",
		prompt: "Ship Done Card History||Implement read-only history view for Done cards",
		agentId: "codex",
		baseRef: "main",
		startInPlanMode: false,
		createdAt: 1000,
		updatedAt: 2000,
		...overrides,
	};
}

function createSelection(card: BoardCard): CardSelection {
	const column = {
		id: "trash" as const,
		title: "Done",
		cards: [card],
	};
	return {
		card,
		column,
		allColumns: [column],
	};
}

describe("DoneTaskDetailView", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		mockGetTaskHistoryQuery.mockReset();
		mockGetCommitChangesQuery.mockReset();
		mockGetTaskPatchChangesQuery.mockReset();
		mockGetTaskPatchChangesQuery.mockResolvedValue({ notFound: true });
		mockGetAgentTranscriptQuery.mockReset();
		mockStartTaskSessionMutate.mockReset();
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("renders task title and prompt read-only without a duplicate header", async () => {
		mockGetTaskHistoryQuery.mockResolvedValue({ events: [] });
		mockGetCommitChangesQuery.mockResolvedValue({ notFound: true, commit: "none" });

		const selection = createSelection(createCard());

		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});

		expect(container.textContent).toContain("Ship Done Card History");
		expect(container.textContent).toContain("Implement read-only history view for Done cards");
		const historyBadge = Array.from(container.querySelectorAll("span")).find(
			(span) => span.textContent === "Read-only history",
		);
		expect(historyBadge?.className).toContain("bg-surface-2");
		const promptLabel = Array.from(container.querySelectorAll("span")).find((span) => span.textContent === "Prompt");
		const prompt = promptLabel?.parentElement?.querySelector("div.mt-1\\.5");
		expect(prompt?.className).not.toContain("border");
		expect(prompt?.className).not.toContain("font-mono");

		expect(container.querySelector("header")).toBeNull();
		expect(Array.from(container.querySelectorAll("button")).some((btn) => btn.textContent?.includes("Back"))).toBe(
			false,
		);
		expect(container.querySelector('[role="separator"][aria-label="Resize task and history panels"]')).not.toBeNull();
		expect(
			container.querySelector('[role="separator"][aria-label="Resize timeline and diff panels"]'),
		).not.toBeNull();
	});

	it("does not call startTaskSession or mutate board on open", async () => {
		mockGetTaskHistoryQuery.mockResolvedValue({ events: [] });

		const selection = createSelection(createCard());
		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});

		expect(mockStartTaskSessionMutate).not.toHaveBeenCalled();
	});

	it("renders timeline labels, agents, timestamps, and colours for seeded history", async () => {
		const events: RuntimeTaskHistoryEvent[] = [
			{ type: "started", agentId: "codex", at: 1000 },
			{
				type: "session",
				agentId: "codex",
				at: 1050,
				agentSession: { agentId: "codex", id: "sess-1", transcriptPath: "/path/to/sess" },
			},
			{ type: "fail", agentId: "codex", round: 1, detail: "first review failed", at: 2000 },
			{ type: "handoff", agentId: "codex", toAgentId: "antigravity", detail: "review limit reached", at: 3000 },
			{ type: "quota_blocked", agentId: "antigravity", at: 4000 },
			{ type: "retry", agentId: "antigravity", toAgentId: "codex", at: 5000 },
			{ type: "pass", agentId: "codex", commit: "a1b2c3d4", at: 6000 },
		];
		mockGetTaskHistoryQuery.mockResolvedValue({ events });
		mockGetCommitChangesQuery.mockResolvedValue({
			repoRoot: "/repo",
			generatedAt: Date.now(),
			files: [{ path: "test.ts", status: "modified", additions: 2, deletions: 1 }],
		});

		const selection = createSelection(createCard());
		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});

		// Check labels
		expect(container.textContent).toContain("Started");
		expect(container.textContent).toContain("Review 1 failed");
		expect(container.textContent).toContain("Handed off to Antigravity");
		expect(container.textContent).toContain("Out of quota");
		expect(container.textContent).toContain("Retried with OpenAI Codex");
		expect(container.textContent).toContain("Passed · a1b2c3d4");

		// Check colours
		const failElement = container.querySelector(".text-status-red");
		expect(failElement).toBeDefined();
		expect(failElement?.textContent).toContain("Review 1 failed");

		const passElement = container.querySelector(".text-status-green");
		expect(passElement).toBeDefined();
		expect(passElement?.textContent).toContain("Passed · a1b2c3d4");

		const orangeElements = Array.from(container.querySelectorAll(".text-status-orange"));
		const orangeText = orangeElements.map((el) => el.textContent).join(" ");
		expect(orangeText).toContain("Handed off to Antigravity");
		expect(orangeText).toContain("Out of quota");
		expect(orangeText).toContain("Retried with OpenAI Codex");

		// Check DiffViewerPanel rendered with files
		expect(container.querySelector('[data-testid="mock-diff-viewer-panel"]')).not.toBeNull();
	});

	it("collapses detail and expands with 'Show all'", async () => {
		const longDetail =
			"Line 1 of failure\nLine 2 of failure\nLine 3 of failure\nLine 4 of failure\nLine 5 of failure";
		const events: RuntimeTaskHistoryEvent[] = [
			{ type: "fail", agentId: "codex", round: 1, detail: longDetail, at: 2000 },
		];
		mockGetTaskHistoryQuery.mockResolvedValue({ events });

		const selection = createSelection(createCard());
		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});

		const showAllButton = Array.from(container.querySelectorAll("button")).find((btn) =>
			btn.textContent?.includes("Show all"),
		);
		expect(showAllButton).toBeDefined();

		// Initially collapsed element has line-clamp-3
		const detailElement = container.querySelector(".line-clamp-3");
		expect(detailElement).not.toBeNull();

		await act(async () => {
			showAllButton?.click();
		});

		// Once expanded, line-clamp-3 is removed
		expect(container.querySelector(".line-clamp-3")).toBeNull();
		expect(container.textContent).toContain("Line 5 of failure");
	});

	it("renders empty states: no history, no commit, and commit not found", async () => {
		// 1. No history recorded for this task.
		mockGetTaskHistoryQuery.mockResolvedValue({ events: [] });
		const selection = createSelection(createCard());

		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});
		expect(container.textContent).toContain("No history recorded for this task.");
		expect(container.textContent).toContain("No commit recorded for this task.");

		// 2. Commit not found on this repository.
		mockGetTaskHistoryQuery.mockResolvedValue({
			events: [{ type: "pass", agentId: "codex", commit: "deadbeef", at: 1000 }],
		});
		mockGetCommitChangesQuery.mockResolvedValue({ notFound: true, commit: "deadbeef" });
		const selectionWithCommit = createSelection(createCard({ id: "done-task-2" }));

		await act(async () => {
			root.render(<DoneTaskDetailView selection={selectionWithCommit} currentProjectId="project-1" />);
		});
		expect(container.textContent).toContain("Commit deadbeef not found on this repository.");
	});

	it("shows the saved patch when no commit was recorded and keeps the fallback when no patch exists", async () => {
		mockGetTaskHistoryQuery.mockResolvedValue({ events: [] });
		mockGetTaskPatchChangesQuery.mockResolvedValue({
			repoRoot: "/repo",
			generatedAt: 1,
			files: [
				{ path: "one.txt", status: "modified", additions: 1, deletions: 1, oldText: "old\n", newText: "new\n" },
			],
		});

		await act(async () => {
			root.render(<DoneTaskDetailView selection={createSelection(createCard())} currentProjectId="project-1" />);
		});
		expect(mockGetTaskPatchChangesQuery).toHaveBeenCalledWith({ taskId: "done-task-1" });
		expect(container.textContent).toContain("Uncommitted changes saved when the task was moved to Done");
		expect(container.textContent).toContain("Files: 1");

		mockGetTaskPatchChangesQuery.mockResolvedValue({ notFound: true });
		await act(async () => {
			root.render(
				<DoneTaskDetailView
					selection={createSelection(createCard({ id: "done-task-2" }))}
					currentProjectId="project-1"
				/>,
			);
		});
		expect(container.textContent).toContain("No commit recorded for this task.");
	});

	it("renders agent transcript panel with turns and handles unavailable message", async () => {
		const events: RuntimeTaskHistoryEvent[] = [
			{
				type: "session",
				agentId: "codex",
				at: 1000,
				agentSession: { agentId: "codex", id: "sess-1", transcriptPath: "/allowed/path" },
			},
			{ type: "pass", agentId: "codex", commit: "c1", at: 2000 },
		];
		mockGetTaskHistoryQuery.mockResolvedValue({ events });
		mockGetCommitChangesQuery.mockResolvedValue({ notFound: true, commit: "c1" });
		mockGetAgentTranscriptQuery.mockResolvedValue({
			turns: [
				{ role: "user", text: "Please fix bug", at: 1001 },
				{ role: "user", text: "# AGENTS.md instructions\nSecret injected instructions", at: 1002 },
				{ role: "assistant", text: "Fixed the bug", at: 1003 },
			],
			truncated: true,
		});

		const selection = createSelection(createCard());
		await act(async () => {
			root.render(<DoneTaskDetailView selection={selection} currentProjectId="project-1" />);
		});

		const viewSessionButton = Array.from(container.querySelectorAll("button")).find((btn) =>
			btn.textContent?.includes("View agent session"),
		);
		expect(viewSessionButton).toBeDefined();

		await act(async () => {
			viewSessionButton?.click();
		});

		expect(mockGetAgentTranscriptQuery).toHaveBeenCalledWith({
			taskId: "done-task-1",
			sessionId: "sess-1",
		});
		expect(container.textContent).toContain("Please fix bug");
		expect(container.textContent).toContain("Fixed the bug");
		expect(container.textContent).toContain("Load earlier");
		const transcriptDialog = container.querySelector(
			'[role="dialog"][aria-modal="true"][aria-label="Agent Transcript"]',
		);
		expect(transcriptDialog).not.toBeNull();
		expect(
			transcriptDialog?.querySelector('[role="separator"][aria-label="Resize transcript panel"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Injected instructions · Show");
		expect(container.textContent).not.toContain("Secret injected instructions");

		const showInstructionsButton = Array.from(transcriptDialog!.querySelectorAll("button")).find((btn) =>
			btn.textContent?.includes("Injected instructions"),
		);
		await act(async () => {
			showInstructionsButton?.click();
		});
		expect(container.textContent).toContain("Secret injected instructions");

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		});
		expect(container.querySelector('[role="dialog"]')).toBeNull();

		const reopenSessionButton = Array.from(container.querySelectorAll("button")).find((btn) =>
			btn.textContent?.includes("View agent session"),
		);
		await act(async () => {
			reopenSessionButton?.click();
		});
		const backdrop = container.querySelector('button[aria-label="Close transcript"]');
		expect(backdrop).not.toBeNull();
		await act(async () => {
			(backdrop as HTMLButtonElement).click();
		});
		expect(container.querySelector('[role="dialog"]')).toBeNull();

		// Test unavailable message on next open
		mockGetAgentTranscriptQuery.mockResolvedValue({ unavailable: "path not allowed" });
		const nextViewSessionButton = Array.from(container.querySelectorAll("button")).find((btn) =>
			btn.textContent?.includes("View agent session"),
		);
		await act(async () => {
			nextViewSessionButton?.click();
		});
		expect(container.textContent).toContain("Transcript not available (path not allowed).");
	});
});
