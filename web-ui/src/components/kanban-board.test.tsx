import type { BeforeCapture, DragStart, DropResult } from "@hello-pangea/dnd";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoard, type RequestProgrammaticCardMove } from "@/components/kanban-board";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { applyDragResult } from "@/state/board-state";
import { isCardDropDisabled } from "@/state/drag-rules";
import type { BoardCard, BoardData } from "@/types";

const dndMock = vi.hoisted(() => ({
	onBeforeCapture: null as ((start: BeforeCapture) => void) | null,
	sensorApi: null as {
		tryGetLock: ReturnType<typeof vi.fn>;
	} | null,
	onDragStart: null as ((start: DragStart) => void) | null,
	onDragEnd: null as ((result: DropResult) => void) | null,
}));

vi.mock("@hello-pangea/dnd", async () => {
	const React = await vi.importActual<typeof import("react")>("react");

	return {
		DragDropContext: ({
			children,
			sensors,
			onDragStart,
			onBeforeCapture,
			onDragEnd,
		}: {
			children: ReactNode;
			sensors?: Array<(api: NonNullable<typeof dndMock.sensorApi>) => void>;
			onDragStart?: (start: DragStart) => void;
			onBeforeCapture?: (start: BeforeCapture) => void;
			onDragEnd: (result: DropResult) => void;
		}): React.ReactElement => {
			dndMock.onBeforeCapture = onBeforeCapture ?? null;
			dndMock.onDragStart = onDragStart ?? null;
			dndMock.onDragEnd = onDragEnd;
			React.useEffect(() => {
				if (!dndMock.sensorApi) {
					return;
				}
				for (const sensor of sensors ?? []) {
					sensor(dndMock.sensorApi);
				}
			}, [sensors]);

			return <>{children}</>;
		},
	};
});

vi.mock("@/components/board-column", () => ({
	BoardColumn: ({
		column,
		onCardClick,
		activeDragSourceColumnId,
	}: {
		column: BoardData["columns"][number];
		activeDragSourceColumnId?: BoardData["columns"][number]["id"] | null;
		onCardClick?: (card: BoardCard) => void;
	}): React.ReactElement => (
		<section
			data-column-id={column.id}
			data-drop-disabled={isCardDropDisabled(column.id, activeDragSourceColumnId ?? null)}
		>
			<div className="kb-column-cards">
				{column.cards.map((card) => (
					<div
						key={card.id}
						data-task-id={card.id}
						data-rfd-draggable-id={card.id}
						onClick={() => onCardClick?.(card)}
					/>
				))}
			</div>
		</section>
	),
}));

vi.mock("@/components/dependencies/dependency-overlay", () => ({
	DependencyOverlay: (): null => null,
}));

vi.mock("@/components/dependencies/use-dependency-linking", () => ({
	useDependencyLinking: () => ({
		draft: null,
		onDependencyPointerDown: vi.fn(),
		onDependencyPointerEnter: vi.fn(),
	}),
}));

function createRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({}),
	} as DOMRect;
}

describe("KanbanBoard", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockImplementation(() => Date.now());
		vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
			return window.setTimeout(() => {
				callback(performance.now());
			}, 16);
		});
		vi.spyOn(window, "cancelAnimationFrame").mockImplementation((handle: number) => {
			window.clearTimeout(handle);
		});
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(
			this: HTMLElement,
		) {
			if (this.dataset.taskId === "source-task") {
				return createRect(20, 20, 160, 96);
			}
			if (this.dataset.taskId === "target-task-1") {
				return createRect(300, 20, 160, 96);
			}
			if (this.classList.contains("kb-column-cards")) {
				const columnId = this.closest<HTMLElement>("[data-column-id]")?.dataset.columnId;
				if (columnId === "backlog") {
					return createRect(12, 12, 176, 420);
				}
				if (columnId === "in_progress") {
					return createRect(292, 12, 176, 420);
				}
			}
			return createRect(0, 0, 0, 0);
		});
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		dndMock.sensorApi = null;
		dndMock.onBeforeCapture = null;
		dndMock.onDragStart = null;
		dndMock.onDragEnd = null;
		vi.restoreAllMocks();
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("marks the board while a programmatic move is active", async () => {
		const dragActions = {
			isActive: vi.fn(() => true),
			move: vi.fn(),
			drop: vi.fn(),
			cancel: vi.fn(),
		};
		const preDrag = {
			fluidLift: vi.fn(() => dragActions),
			isActive: vi.fn(() => true),
			abort: vi.fn(),
		};
		dndMock.sensorApi = {
			tryGetLock: vi.fn(() => preDrag),
		};

		const board: BoardData = {
			columns: [
				{
					id: "backlog",
					title: "Backlog",
					cards: [
						{
							id: "source-task",
							title: "Source task",
							prompt: "Source task",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{
					id: "in_progress",
					title: "In Progress",
					cards: [
						{
							id: "target-task-1",
							title: "Target task 1",
							prompt: "Target task 1",
							startInPlanMode: false,
							autoReviewEnabled: false,
							autoReviewMode: "commit",
							baseRef: "main",
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};

		let requestMove: RequestProgrammaticCardMove | null = null;

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={() => {}}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});

		const boardElement = container.querySelector<HTMLElement>(".kb-board");
		expect(boardElement?.dataset.programmaticCardMove).toBeUndefined();

		await act(async () => {
			requestMove?.({
				taskId: "source-task",
				fromColumnId: "backlog",
				toColumnId: "in_progress",
				insertAtTop: true,
			});
		});

		expect(boardElement?.dataset.programmaticCardMove).toBe("true");
	});

	function createCard(id: string): BoardCard {
		return {
			id,
			title: id,
			prompt: id,
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			createdAt: 1,
			updatedAt: 1,
		};
	}

	async function renderAttentionBoard(columnId: "review" | "in_progress") {
		let board: BoardData = {
			columns: [
				{
					id: columnId,
					title: columnId,
					cards: [
						{ ...createCard("sidebar-a"), agentReviewEnabled: true, quotaBlockedAt: 1 },
						createCard("owner-a"),
						{ ...createCard("sidebar-b"), agentReviewEnabled: true, quotaBlockedAt: 1 },
						createCard("owner-b"),
					],
				},
			],
			dependencies: [],
		};
		const sessions: Record<string, RuntimeTaskSessionSummary> =
			columnId === "in_progress"
				? {
						"owner-b": {
							taskId: "owner-b",
							state: "running",
							agentId: "codex",
							workspacePath: null,
							pid: null,
							startedAt: null,
							updatedAt: 1,
							lastOutputAt: null,
							reviewReason: null,
							exitCode: null,
							lastHookAt: null,
							latestHookActivity: {
								activityText: "Waiting for approval",
								toolName: null,
								toolInputSummary: null,
								finalMessage: null,
								hookEventName: null,
								notificationType: null,
								source: null,
							},
						},
					}
				: {};
		const render = () =>
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={sessions}
					onCardSelect={() => {}}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={(result) => {
						board = applyDragResult(board, result).board;
						render();
					}}
				/>,
			);
		await act(async () => {
			render();
		});
		return {
			ids: () =>
				Array.from(container.querySelectorAll("[data-task-id]"), (node) => node.getAttribute("data-task-id")),
			storedIds: () => board.columns[0]?.cards.map(({ id }) => id),
		};
	}

	it("renders owner cards first in Review keeping relative order", async () => {
		const view = await renderAttentionBoard("review");
		expect(view.ids()).toEqual(["owner-a", "owner-b", "sidebar-a", "sidebar-b"]);
		expect(view.storedIds()).toEqual(["sidebar-a", "owner-a", "sidebar-b", "owner-b"]);
	});

	it("renders approval wait first in In Progress", async () => {
		const view = await renderAttentionBoard("in_progress");
		expect(view.ids()).toEqual(["owner-b", "sidebar-a", "owner-a", "sidebar-b"]);
	});

	it.each([
		["sidebar-a", 1, 3, ["owner-b", "owner-a", "sidebar-b", "sidebar-a"]],
		["sidebar-b", 3, 1, ["owner-b", "sidebar-b", "sidebar-a", "owner-a"]],
	] as const)("drops a dragged card at the shown position in a sorted column: %s", async (id, from, to, expected) => {
		const view = await renderAttentionBoard("in_progress");
		await act(async () => {
			dndMock.onBeforeCapture?.({ draggableId: id, mode: "FLUID" });
		});
		expect(container.querySelector('[data-column-id="in_progress"]')?.getAttribute("data-drop-disabled")).toBe(
			"false",
		);
		await act(async () => {
			dndMock.onDragEnd?.({
				draggableId: id,
				type: "CARD",
				reason: "DROP",
				mode: "FLUID",
				combine: null,
				source: { droppableId: "in_progress", index: from },
				destination: { droppableId: "in_progress", index: to },
			});
		});
		expect(view.ids()).toEqual(expected);
	});

	it("rejects a Review to Review drag", async () => {
		const view = await renderAttentionBoard("review");
		await act(async () => {
			dndMock.onBeforeCapture?.({ draggableId: "owner-a", mode: "FLUID" });
		});
		expect(container.querySelector('[data-column-id="review"]')?.getAttribute("data-drop-disabled")).toBe("true");
		await act(async () => {
			dndMock.onDragEnd?.({
				draggableId: "owner-a",
				type: "CARD",
				reason: "DROP",
				mode: "FLUID",
				combine: null,
				source: { droppableId: "review", index: 0 },
				destination: null,
			});
		});
		expect(view.ids()).toEqual(["owner-a", "owner-b", "sidebar-a", "sidebar-b"]);
		expect(view.storedIds()).toEqual(["sidebar-a", "owner-a", "sidebar-b", "owner-b"]);
	});

	async function renderWithProgrammaticMove() {
		const dragActions = {
			isActive: vi.fn(() => true),
			move: vi.fn(),
			drop: vi.fn(() => {
				dragActions.isActive.mockReturnValue(false);
			}),
			cancel: vi.fn(),
		};
		const preDrag = {
			fluidLift: vi.fn(() => dragActions),
			isActive: vi.fn(() => true),
			abort: vi.fn(),
		};
		dndMock.sensorApi = {
			tryGetLock: vi.fn(() => preDrag),
		};
		const onCardSelect = vi.fn();
		const onDragEnd = vi.fn();
		let requestMove: RequestProgrammaticCardMove | null = null;
		const board: BoardData = {
			columns: [
				{ id: "backlog", title: "Backlog", cards: [createCard("source-task")] },
				{ id: "in_progress", title: "In Progress", cards: [createCard("target-task-1")] },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Done", cards: [] },
			],
			dependencies: [],
		};

		await act(async () => {
			root.render(
				<KanbanBoard
					data={board}
					taskSessions={{}}
					onCardSelect={onCardSelect}
					onCreateTask={() => {}}
					dependencies={[]}
					onDragEnd={onDragEnd}
					onRequestProgrammaticCardMoveReady={(nextRequestMove) => {
						requestMove = nextRequestMove;
					}}
				/>,
			);
		});

		let started = false;
		await act(async () => {
			started =
				requestMove?.({
					taskId: "source-task",
					fromColumnId: "backlog",
					toColumnId: "in_progress",
					insertAtTop: true,
				}) ?? false;
		});
		expect(started).toBe(true);
		dndMock.onDragStart?.({
			draggableId: "source-task",
			type: "CARD",
			source: { droppableId: "backlog", index: 0 },
			mode: "FLUID",
		});

		const dropResult: DropResult = {
			draggableId: "source-task",
			type: "CARD",
			source: { droppableId: "backlog", index: 0 },
			reason: "DROP",
			mode: "FLUID",
			destination: { droppableId: "in_progress", index: 0 },
			combine: null,
		};
		return { dragActions, onCardSelect, onDragEnd, dropResult };
	}

	function clickAt(element: Element, clientX: number, clientY: number): void {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY }));
	}

	it("finishes a stalled drop animation so the card does not stay locked", async () => {
		const { dragActions, dropResult } = await renderWithProgrammaticMove();
		const scrollListener = vi.fn();
		window.addEventListener("scroll", scrollListener);

		await act(async () => {
			vi.advanceTimersByTime(300);
		});
		expect(dragActions.drop).toHaveBeenCalledTimes(1);
		expect(scrollListener).not.toHaveBeenCalled();

		// The card remounted mid-drop, so hello-pangea never sees `transitionend` and onDragEnd never fires.
		await act(async () => {
			vi.advanceTimersByTime(600);
		});
		expect(scrollListener).toHaveBeenCalled();

		// hello-pangea's scroll listener finishes the drop and reports it; the nudging stops.
		await act(async () => {
			dndMock.onDragEnd?.(dropResult);
		});
		scrollListener.mockClear();
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(scrollListener).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLElement>(".kb-board")?.dataset.programmaticCardMove).toBeUndefined();
		window.removeEventListener("scroll", scrollListener);
	});

	it("opens the moving card and finishes the move when the user clicks it mid-animation", async () => {
		const { dragActions, onCardSelect } = await renderWithProgrammaticMove();
		const scrollListener = vi.fn();
		window.addEventListener("scroll", scrollListener);

		// The moving card has `pointer-events: none`, so the click lands on the board underneath it.
		const boardElement = container.querySelector(".kb-board");
		if (!boardElement) {
			throw new Error("Expected board element.");
		}
		await act(async () => {
			clickAt(boardElement, 60, 60);
		});

		expect(onCardSelect).toHaveBeenCalledWith("source-task");
		expect(dragActions.drop).toHaveBeenCalledTimes(1);
		await act(async () => {
			vi.advanceTimersByTime(60);
		});
		expect(scrollListener).toHaveBeenCalled();
		window.removeEventListener("scroll", scrollListener);
	});

	it("does not swallow clicks on other cards during a programmatic move", async () => {
		const { onCardSelect } = await renderWithProgrammaticMove();
		const otherCard = container.querySelector('[data-task-id="target-task-1"]');
		if (!otherCard) {
			throw new Error("Expected target card.");
		}

		await act(async () => {
			clickAt(otherCard, 350, 60);
		});

		expect(onCardSelect).toHaveBeenCalledWith("target-task-1");
	});

	it("opens the card right after a programmatic move ends", async () => {
		const { onCardSelect, dropResult } = await renderWithProgrammaticMove();
		await act(async () => {
			vi.advanceTimersByTime(300);
			dndMock.onDragEnd?.(dropResult);
		});
		const movedCard = container.querySelector('[data-task-id="source-task"]');
		if (!movedCard) {
			throw new Error("Expected moved card.");
		}

		await act(async () => {
			clickAt(movedCard, 60, 60);
		});

		expect(onCardSelect).toHaveBeenCalledWith("source-task");
	});

	it("reports an in-flight programmatic move as canceled when the board unmounts", async () => {
		const { onDragEnd } = await renderWithProgrammaticMove();

		act(() => {
			root.unmount();
		});
		root = createRoot(container);

		expect(onDragEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				draggableId: "source-task",
				reason: "CANCEL",
				destination: null,
				source: { droppableId: "backlog", index: 0 },
			}),
		);
	});
});
