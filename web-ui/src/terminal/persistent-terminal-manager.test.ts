import { afterEach, describe, expect, it, vi } from "vitest";

const mockTerminal = {
	attachCustomKeyEventHandler: vi.fn(),
	cols: 80,
	dispose: vi.fn(),
	hasSelection: vi.fn(() => false),
	input: vi.fn(),
	loadAddon: vi.fn(),
	onBinary: vi.fn(),
	onData: vi.fn(),
	open: vi.fn(),
	options: { theme: {} },
	paste: vi.fn(),
	reset: vi.fn(),
	resize: vi.fn(),
	rows: 24,
	unicode: { activeVersion: "" },
	write: vi.fn((_data: unknown, callback?: () => void) => callback?.()),
};

vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit = vi.fn();
	},
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		onContextLoss() {}
	},
}));
vi.mock("@xterm/xterm", () => ({
	Terminal: class {
		constructor() {
			Object.assign(this, mockTerminal);
		}
	},
}));
vi.mock("@/hooks/use-theme", () => ({ getTerminalThemeColors: vi.fn(() => ({})) }));
vi.mock("@/runtime/task-session-geometry", () => ({
	estimateTaskSessionGeometry: vi.fn(() => ({ cols: 80, rows: 24 })),
}));
vi.mock("@/runtime/trpc-client", () => ({ getRuntimeTrpcClient: vi.fn() }));
vi.mock("@/terminal/terminal-geometry-registry", () => ({
	clearTerminalGeometry: vi.fn(),
	reportTerminalGeometry: vi.fn(),
}));
vi.mock("@/terminal/terminal-options", () => ({ createKanbanTerminalOptions: vi.fn(() => ({})) }));
vi.mock("@/terminal/terminal-prompt-heuristics", () => ({
	appendTerminalHeuristicText: vi.fn(),
	hasInterruptAcknowledgement: vi.fn(),
	hasLikelyShellPrompt: vi.fn(),
}));
vi.mock("@/utils/platform", () => ({ isMacPlatform: false }));

import { disposePersistentTerminal, ensurePersistentTerminal } from "@/terminal/persistent-terminal-manager";

class MockWebSocket {
	static readonly OPEN = 1;
	static readonly CONNECTING = 0;
	static instances: MockWebSocket[] = [];
	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	binaryType = "";
	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	private readonly listeners = new Map<string, Set<EventListener>>();

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		const listeners = this.listeners.get(type) ?? new Set<EventListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	close(): void {
		this.readyState = 3;
	}

	triggerClose(code: number): void {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code }));
	}
}

describe("persistent terminal stalled stream reconnects", () => {
	afterEach(() => {
		disposePersistentTerminal("workspace", "task");
		MockWebSocket.instances = [];
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	const createTerminal = (onLastError: (message: string | null) => void) => {
		vi.stubGlobal("WebSocket", MockWebSocket);
		const terminal = ensurePersistentTerminal({
			workspaceId: "workspace",
			taskId: "task",
			cursorColor: "#fff",
			terminalBackgroundColor: "#000",
		});
		terminal.subscribe({ onLastError });
		return terminal;
	};

	it("reconnects sockets closed with code 4000 without reporting an error", () => {
		const onLastError = vi.fn();
		createTerminal(onLastError);
		const ioSocket = MockWebSocket.instances[0];
		const controlSocket = MockWebSocket.instances[1];
		if (!ioSocket || !controlSocket) {
			throw new Error("Expected initial terminal sockets.");
		}
		ioSocket.triggerClose(4000);
		expect(MockWebSocket.instances).toHaveLength(3);
		expect(onLastError).not.toHaveBeenCalledWith(expect.stringContaining("Close and reopen"));
		controlSocket.triggerClose(4000);
		expect(MockWebSocket.instances).toHaveLength(4);
		expect(onLastError).not.toHaveBeenCalledWith(expect.stringContaining("Close and reopen"));
	});

	it("keeps the existing error for other close codes", () => {
		const onLastError = vi.fn();
		createTerminal(onLastError);
		const ioSocket = MockWebSocket.instances[0];
		const controlSocket = MockWebSocket.instances[1];
		if (!ioSocket || !controlSocket) {
			throw new Error("Expected initial terminal sockets.");
		}
		ioSocket.triggerClose(1006);
		expect(onLastError).toHaveBeenLastCalledWith("Terminal stream closed. Close and reopen to reconnect.");
		controlSocket.triggerClose(1006);
		expect(onLastError).toHaveBeenLastCalledWith(
			"Terminal control connection closed. Close and reopen to reconnect.",
		);
	});
});
