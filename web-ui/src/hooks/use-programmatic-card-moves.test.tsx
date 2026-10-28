import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RequestProgrammaticCardMove } from "@/components/kanban-board";
import { useProgrammaticCardMoves } from "@/hooks/use-programmatic-card-moves";

type ProgrammaticCardMoves = ReturnType<typeof useProgrammaticCardMoves>;

describe("useProgrammaticCardMoves", () => {
	let container: HTMLDivElement;
	let root: Root;
	let moves: ProgrammaticCardMoves | null;
	let previousActEnvironment: boolean | undefined;

	function HookHarness(): null {
		moves = useProgrammaticCardMoves();
		return null;
	}

	function getMoves(): ProgrammaticCardMoves {
		if (!moves) {
			throw new Error("Expected hook to be rendered.");
		}
		return moves;
	}

	beforeEach(async () => {
		vi.useFakeTimers();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
		moves = null;
		await act(async () => {
			root.render(<HookHarness />);
		});
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		vi.useRealTimers();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("releases the in-flight move when the board cannot animate it", () => {
		const requestMove = vi.fn<RequestProgrammaticCardMove>(() => false);
		getMoves().handleProgrammaticCardMoveReady(requestMove);

		expect(getMoves().tryProgrammaticCardMove("task-1", "in_progress", "review")).toBe("unavailable");
		requestMove.mockReturnValue(true);
		expect(getMoves().tryProgrammaticCardMove("task-1", "in_progress", "review")).toBe("started");
	});

	it("unblocks queued moves as soon as the in-flight move ends", async () => {
		getMoves().handleProgrammaticCardMoveReady(vi.fn<RequestProgrammaticCardMove>(() => true));
		expect(getMoves().tryProgrammaticCardMove("task-1", "in_progress", "review")).toBe("started");
		expect(getMoves().tryProgrammaticCardMove("task-1", "review", "in_progress")).toBe("blocked");

		const onAvailable = vi.fn();
		void getMoves().waitForProgrammaticCardMoveAvailability().then(onAvailable);
		await act(async () => {
			getMoves().consumeProgrammaticCardMove("task-1");
		});

		expect(onAvailable).toHaveBeenCalledTimes(1);
		expect(getMoves().tryProgrammaticCardMove("task-1", "review", "in_progress")).toBe("started");
	});

	it("releases the in-flight move when the drag ends canceled", async () => {
		getMoves().handleProgrammaticCardMoveReady(vi.fn<RequestProgrammaticCardMove>(() => true));
		expect(getMoves().tryProgrammaticCardMove("task-1", "review", "trash", { skipTrashWorkflow: true })).toBe(
			"started",
		);

		let consumed: ReturnType<ProgrammaticCardMoves["consumeProgrammaticCardMove"]> | null = null;
		await act(async () => {
			consumed = getMoves().consumeProgrammaticCardMove("task-1");
		});

		expect(consumed).toMatchObject({
			behavior: { skipTrashWorkflow: true },
			programmaticCardMoveInFlight: { taskId: "task-1", fromColumnId: "review", toColumnId: "trash" },
		});
		expect(getMoves().tryProgrammaticCardMove("task-2", "in_progress", "review")).toBe("started");
	});
});
