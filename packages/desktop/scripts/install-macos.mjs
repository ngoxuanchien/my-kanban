#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
	console.error("desktop:install is only supported on macOS.");
	process.exit(1);
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const appPath = resolve(desktopRoot, "out/mac-arm64/Kanban.app");
const installPath = "/Applications/Kanban.app";

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error || result.status !== 0) {
		console.error(
			`desktop:install failed: ${result.error?.message ?? `${command} exited with status ${result.status ?? "unknown"}`}`,
		);
		process.exit(result.status || 1);
	}
}

run("npm", ["run", "build"], { cwd: repoRoot });
run("npm", ["run", "build:mac:arm64"], {
	cwd: desktopRoot,
	env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
});

if (!existsSync(appPath)) {
	console.error(`desktop:install failed: expected app bundle at ${appPath}`);
	process.exit(1);
}

run("osascript", ["-e", 'if application "Kanban" is running then tell application "Kanban" to quit']);
rmSync(installPath, { recursive: true, force: true });
run("ditto", [appPath, installPath]);
run("codesign", ["--verify", "--deep", "--strict", installPath]);
console.log(`desktop:install: installed ${installPath}`);
