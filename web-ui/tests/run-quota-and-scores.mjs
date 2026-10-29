import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

const testsDir = dirname(fileURLToPath(import.meta.url));
const webUiDir = resolve(testsDir, "..");
const rootDir = resolve(webUiDir, "..");
const repoPath = rootDir;
const workspaceId = repoPath.split(/[\\/]/).filter(Boolean).at(-1).toLowerCase().replace(/[^a-z0-9]+/g, "-");

async function getAvailablePort() {
	const server = createServer();
	await new Promise((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveListen);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not allocate runtime port.");
	await new Promise((resolveClose) => server.close(resolveClose));
	return address.port;
}

async function waitForRuntime(port, child) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`Runtime exited with code ${child.exitCode}.`);
		const connected = await new Promise((resolveConnect) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolveConnect(true);
			});
			socket.once("error", () => resolveConnect(false));
		});
		if (connected) return;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
	}
	throw new Error("Timed out waiting for the isolated Kanban runtime.");
}

function card(id, quotaBlockedAt) {
	const now = Date.now();
	return {
		id,
		title: "Quota score smoke card",
		prompt: "Quota score smoke card",
		startInPlanMode: false,
		agentReviewEnabled: false,
		reviewRound: 1,
		...(quotaBlockedAt === undefined ? {} : { quotaBlockedAt }),
		agentId: "codex",
		baseRef: "main",
		createdAt: now,
		updatedAt: now,
	};
}

function scoreEvents() {
	const events = [];
	const record = (type, agentId, taskId, round) => events.push({ type, agentId, taskId, ...(round === undefined ? {} : { round }), at: 1 });
	for (let i = 1; i <= 6; i += 1) {
		const id = `codex-task-${i}`;
		record("assigned", "codex", id);
		record("pass", "codex", id);
		if (i <= 2) record("fail", "codex", id, 1);
	}
	record("assigned", "antigravity", "antigravity-task-1");
	for (let i = 1; i <= 4; i += 1) {
		const id = `opencode-task-${i}`;
		record("assigned", "opencode", id);
		if (i <= 3) record("fail", "opencode", id, 1);
	}
	return events;
}

const temporaryHome = await mkdtemp(join(tmpdir(), "kanban-quota-scores-"));
const workspaceDir = join(temporaryHome, ".cline", "kanban", "workspaces", workspaceId);
const workspacesDir = dirname(workspaceDir);
const runtimePort = await getAvailablePort();
let runtime;

try {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(join(workspacesDir, "index.json"), JSON.stringify({
		version: 1,
		entries: { [workspaceId]: { workspaceId, repoPath } },
		repoPathToId: { [repoPath]: workspaceId },
	}));
	await writeFile(join(workspaceDir, "board.json"), JSON.stringify({
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [card("quota-blocked-smoke", Date.now()), card("quota-clear-smoke")] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	}));
	await writeFile(join(workspaceDir, "sessions.json"), "{}");
	await writeFile(join(workspaceDir, "meta.json"), JSON.stringify({ revision: 1, updatedAt: 1 }));
	await writeFile(join(workspaceDir, "agent-scores.json"), JSON.stringify({ version: 1, events: scoreEvents() }));

	const runtimeEnv = {
		...process.env,
		HOME: temporaryHome,
		// Keep installed coding-agent CLIs out of this no-agent smoke runtime.
		PATH: [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
		NODE_ENV: "development",
		KANBAN_RUNTIME_PORT: String(runtimePort),
	};
	runtime = spawn(join(rootDir, "node_modules/.bin/tsx"), ["src/cli.ts", "--no-open", "--no-passcode", "--skip-shutdown-cleanup", "--port", String(runtimePort)], {
		cwd: rootDir,
		env: runtimeEnv,
		stdio: "inherit",
		detached: process.platform !== "win32",
	});
	await waitForRuntime(runtimePort, runtime);

	const result = spawnSync(process.execPath, [
		join(webUiDir, "node_modules/.bin/playwright"),
		"test",
		"tests/quota-and-scores.spec.ts",
		"--reporter=list",
	], {
		cwd: webUiDir,
		env: { ...process.env, CI: "1", KANBAN_RUNTIME_PORT: String(runtimePort), KANBAN_SMOKE_WORKSPACE_DIR: workspaceDir },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
	if (runtime && process.platform !== "win32" && runtime.pid) {
		try {
			process.kill(-runtime.pid, "SIGTERM");
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	} else if (runtime && runtime.exitCode === null) {
		runtime.kill("SIGTERM");
	}
	if (runtime && runtime.exitCode === null) {
		await new Promise((resolveExit) => runtime.once("exit", resolveExit));
	}
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await rm(temporaryHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
		try {
			await access(temporaryHome);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
		} catch (error) {
			if (error.code === "ENOENT") break;
			throw error;
		}
		if (attempt === 7) throw new Error(`Temporary runtime home was recreated after cleanup: ${temporaryHome}`);
	}
}
