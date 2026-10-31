import { shell } from "electron";

/**
 * `shell.openExternal` returns a Promise that can reject if the OS denies
 * the open (no default browser, policy restriction, malformed URL). Wrap
 * with a `.catch` so a Help-menu click never produces an unhandled
 * rejection — failure should surface as a console warning, not crash the
 * Electron renderer-warnings pipeline.
 */
export function openExternalSafe(url: string): void {
	shell.openExternal(url).catch((err: unknown) => {
		console.warn(
			"[desktop] shell.openExternal failed:",
			err instanceof Error ? err.message : err,
		);
	});
}
