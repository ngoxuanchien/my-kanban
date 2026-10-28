import serializeAddonModule from "@xterm/addon-serialize";
import headlessTerminalModule from "@xterm/headless";

const { SerializeAddon } = serializeAddonModule as typeof import("@xterm/addon-serialize");
const { Terminal } = headlessTerminalModule as typeof import("@xterm/headless");

const TERMINAL_SCROLLBACK = 10_000;
// DECSET modes for SGR mouse encoding (1006) and its pixel variant (1016).
const SGR_MOUSE_ENCODING_MODES = new Set([1006, 1016]);

export interface TerminalRestoreSnapshot {
	snapshot: string;
	cols: number;
	rows: number;
}

interface TerminalStateMirrorOptions {
	onInputResponse?: (data: string) => void;
}

export class TerminalStateMirror {
	private readonly terminal: InstanceType<typeof Terminal>;
	private readonly serializeAddon = new SerializeAddon();
	private operationQueue: Promise<void> = Promise.resolve();
	// SerializeAddon restores mouse tracking but not its encoding, so a restored viewer would report the
	// mouse as X10. TUIs that asked for SGR (OpenCode) read X10 reports past column 94 as typed text.
	private sgrMouseEncodingMode: number | null = null;

	constructor(cols: number, rows: number, options: TerminalStateMirrorOptions = {}) {
		this.terminal = new Terminal({
			allowProposedApi: true,
			cols,
			rows,
			scrollback: TERMINAL_SCROLLBACK,
		});
		this.terminal.loadAddon(this.serializeAddon);
		for (const [final, enabled] of [
			["h", true],
			["l", false],
		] as const) {
			this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				for (const mode of params) {
					if (typeof mode === "number" && SGR_MOUSE_ENCODING_MODES.has(mode)) {
						this.sgrMouseEncodingMode = enabled ? mode : null;
					}
				}
				// Let xterm apply the mode too.
				return false;
			});
		}
		this.terminal.onData((data) => {
			options.onInputResponse?.(data);
		});
	}

	applyOutput(chunk: Buffer): void {
		const chunkCopy = new Uint8Array(chunk);
		this.enqueueOperation(
			() =>
				new Promise<void>((resolve) => {
					this.terminal.write(chunkCopy, () => {
						resolve();
					});
				}),
		);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.terminal.cols && rows === this.terminal.rows) {
			return;
		}
		this.enqueueOperation(() => {
			this.terminal.resize(cols, rows);
		});
	}

	async getSnapshot(): Promise<TerminalRestoreSnapshot> {
		await this.operationQueue;
		return {
			snapshot:
				this.serializeAddon.serialize() +
				(this.sgrMouseEncodingMode === null ? "" : `\u001b[?${this.sgrMouseEncodingMode}h`),
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		};
	}

	dispose(): void {
		this.terminal.dispose();
	}

	private enqueueOperation(operation: () => void | Promise<void>): void {
		this.operationQueue = this.operationQueue
			.catch(() => undefined)
			.then(async () => {
				await operation();
			});
	}
}
