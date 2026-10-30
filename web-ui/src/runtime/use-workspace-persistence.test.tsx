import { act, type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInitialBoardData } from "@/data/board-data";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";
import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "@/runtime/types";
import { type UseWorkspacePersistenceParams, useWorkspacePersistence } from "@/runtime/use-workspace-persistence";
import * as workspaceStateQuery from "@/runtime/workspace-state-query";
import type { BoardData } from "@/types";

function createBoard(prompt: string): BoardData {
	const board = createInitialBoardData();
	board.columns[0]!.cards.push({
		id: "task-1",
		title: prompt,
		prompt,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	});
	return board;
}

function createWorkspaceResponse(board: BoardData, revision = 2): RuntimeWorkspaceStateResponse {
	return {
		repoPath: "/tmp/repo",
		statePath: "/tmp/state",
		git: {
			currentBranch: "main",
			defaultBranch: "main",
			branches: ["main"],
		},
		board,
		sessions: {},
		revision,
	};
}

function Harness({
	persistWorkspaceState,
	onReady,
}: {
	persistWorkspaceState: UseWorkspacePersistenceParams["persistWorkspaceState"];
	onReady: (
		setBoard: Dispatch<SetStateAction<BoardData>>,
		revision: number | null,
		board: BoardData,
		applyWorkspaceState: (state: RuntimeWorkspaceStateResponse | null) => void,
	) => void;
}): null {
	const [board, setBoard] = useState(() => createBoard("stale local edit"));
	const [streamedWorkspaceState] = useState(() => createWorkspaceResponse(createBoard("stale local edit"), 1));
	const [sessions, setSessions] = useState<Record<string, RuntimeTaskSessionSummary>>({});
	const [canPersistWorkspaceState, setCanPersistWorkspaceState] = useState(false);
	const sync = useWorkspaceSync({
		currentProjectId: "workspace-1",
		streamedWorkspaceState,
		hasNoProjects: false,
		hasReceivedSnapshot: false,
		isDocumentVisible: true,
		setBoard,
		setSessions,
		setCanPersistWorkspaceState,
	});
	useWorkspacePersistence({
		board,
		sessions,
		currentProjectId: "workspace-1",
		workspaceRevision: sync.workspaceRevision,
		hydrationNonce: sync.workspaceHydrationNonce,
		canPersistWorkspaceState,
		isDocumentVisible: true,
		isWorkspaceStateRefreshing: sync.isWorkspaceStateRefreshing,
		persistWorkspaceState,
		refetchWorkspaceState: sync.refreshWorkspaceState,
		onWorkspaceRevisionChange: sync.setWorkspaceRevision,
	});
	useEffect(
		() => onReady(setBoard, sync.workspaceRevision, board, sync.applyWorkspaceState),
		[board, onReady, setBoard, sync.applyWorkspaceState, sync.workspaceRevision],
	);
	return null;
}

describe("useWorkspacePersistence conflicts", () => {
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
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("hydrates the refetched server board before the next save", async () => {
		const persistedBoards: BoardData[] = [];
		const persistWorkspaceState = vi.fn<UseWorkspacePersistenceParams["persistWorkspaceState"]>(
			async ({ payload }) => {
				persistedBoards.push(payload.board);
				if (persistedBoards.length === 1)
					throw new workspaceStateQuery.WorkspaceStateConflictError(2, "revision conflict");
				return createWorkspaceResponse(payload.board);
			},
		);
		let setBoard: Dispatch<SetStateAction<BoardData>> | null = null;
		let currentRevision: number | null = null;
		const latestBoard: { current: BoardData | null } = { current: null };
		const onReady = (
			setter: Dispatch<SetStateAction<BoardData>>,
			revision: number | null,
			board: BoardData,
			_applyWorkspaceState: (state: RuntimeWorkspaceStateResponse | null) => void,
		) => {
			setBoard = setter;
			currentRevision = revision;
			latestBoard.current = board;
		};
		let resolveRefetch!: (state: RuntimeWorkspaceStateResponse) => void;
		vi.spyOn(workspaceStateQuery, "fetchWorkspaceState").mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveRefetch = resolve;
				}),
		);

		await act(async () => {
			root.render(<Harness {...{ persistWorkspaceState, onReady }} />);
		});
		await act(async () => {
			setBoard?.(createBoard("losing local edit"));
		});
		await act(async () => new Promise((resolve) => window.setTimeout(resolve, 160)));
		expect(workspaceStateQuery.fetchWorkspaceState).toHaveBeenCalledTimes(1);
		await act(async () => {
			resolveRefetch(createWorkspaceResponse(createBoard("server board")));
			await Promise.resolve();
		});
		await act(async () => {
			setBoard?.((current) => ({ ...current, dependencies: [...current.dependencies] }));
		});
		await act(async () => new Promise((resolve) => window.setTimeout(resolve, 160)));

		expect(workspaceStateQuery.fetchWorkspaceState).toHaveBeenCalledTimes(1);
		expect(latestBoard.current?.columns[0]?.cards[0]?.prompt).toBe("server board");
		expect(persistedBoards[0]?.columns[0]?.cards[0]?.prompt).toBe("losing local edit");
		expect(persistedBoards[1]?.columns[0]?.cards[0]?.prompt).toBe("server board");
		expect(currentRevision).toBe(2);
	});

	it("uses the moved state's revision for the next save", async () => {
		const persistWorkspaceState = vi.fn<UseWorkspacePersistenceParams["persistWorkspaceState"]>(async ({ payload }) =>
			createWorkspaceResponse(payload.board),
		);
		let setBoard: Dispatch<SetStateAction<BoardData>> | null = null;
		let applyWorkspaceState: ((state: RuntimeWorkspaceStateResponse | null) => void) | null = null;
		const onReady = (
			setter: Dispatch<SetStateAction<BoardData>>,
			_revision: number | null,
			_board: BoardData,
			apply: (state: RuntimeWorkspaceStateResponse | null) => void,
		) => {
			setBoard = setter;
			applyWorkspaceState = apply;
		};

		await act(async () => root.render(<Harness {...{ persistWorkspaceState, onReady }} />));
		await act(async () => new Promise((resolve) => window.setTimeout(resolve, 160)));
		const movedBoard = createBoard("server move");
		await act(async () => {
			applyWorkspaceState?.(createWorkspaceResponse(movedBoard, 2));
		});
		await act(async () => {
			setBoard?.((current) => ({ ...current, dependencies: [...current.dependencies] }));
		});
		await act(async () => new Promise((resolve) => window.setTimeout(resolve, 160)));

		expect(persistWorkspaceState).toHaveBeenCalledTimes(1);
		expect(persistWorkspaceState.mock.calls[0]?.[0].payload.expectedRevision).toBe(2);
	});
});
