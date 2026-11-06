import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { EffectiveSkillSet } from "../../../src/core/employee-skill-set";
import { createGitProcessEnv } from "../../../src/core/git-process-env";
import { prepareAgentLaunch } from "../../../src/terminal/agent-session-adapters";
import { createGitTestEnv } from "../../utilities/git-env";

const originalHome = process.env.HOME;
const originalAppData = process.env.APPDATA;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempHome: string | null = null;
const originalArgv = [...process.argv];
const originalExecArgv = [...process.execArgv];
const originalExecPath = process.execPath;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-agent-adapters-"));
	process.env.HOME = tempHome;
	return tempHome;
}

function setKanbanProcessContext(): void {
	process.argv = ["node", "/Users/example/repo/dist/cli.js"];
	process.execArgv = [];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: "/usr/local/bin/node",
	});
}

function getCodexConfigOverrideValues(args: string[], key: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-c" || arg === "--config") {
			const next = args[index + 1];
			if (typeof next === "string" && next.startsWith(`${key}=`)) {
				values.push(next.slice(key.length + 1));
			}
			index += 1;
			continue;
		}
		if (arg.startsWith(`-c${key}=`)) {
			values.push(arg.slice(key.length + 3));
			continue;
		}
		if (arg.startsWith(`--config=${key}=`)) {
			values.push(arg.slice(key.length + 10));
		}
	}
	return values;
}

afterEach(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalAppData === undefined) {
		delete process.env.APPDATA;
	} else {
		process.env.APPDATA = originalAppData;
	}
	if (originalLocalAppData === undefined) {
		delete process.env.LOCALAPPDATA;
	} else {
		process.env.LOCALAPPDATA = originalLocalAppData;
	}
	process.argv = [...originalArgv];
	process.execArgv = [...originalExecArgv];
	Object.defineProperty(process, "execPath", {
		configurable: true,
		value: originalExecPath,
	});
});

describe("prepareAgentLaunch hook strategies", () => {
	it("configures Codex hooks without legacy notify", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const launchCommand = [launch.binary ?? "", ...launch.args].join(" ");
		expect(launchCommand).toContain("codex");
		expect(launchCommand).toContain("codex-hook");
		expect(launchCommand).toContain("hooks.UserPromptSubmit");
		expect(launchCommand).toContain("hooks.Stop");
		expect(launchCommand).toContain("hooks.PermissionRequest");
		expect(getCodexConfigOverrideValues(launch.args, "features.hooks")).toEqual(["true"]);
		expect(getCodexConfigOverrideValues(launch.args, "features.codex_hooks")).toEqual([]);
		const hookTrustState = getCodexConfigOverrideValues(launch.args, "hooks.state");
		expect(hookTrustState).toHaveLength(1);
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:user_prompt_submit:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:stop:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:pre_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('"/<session-flags>/config.toml:post_tool_use:0:0"');
		expect(hookTrustState[0]).toContain('trusted_hash="sha256:');
		expect(launchCommand).toContain("timeout=5");
		expect(launchCommand).not.toContain("codex-wrapper");
		expect(launchCommand).not.toContain("notify=");

		const wrapperPath = join(homedir(), ".cline", "kanban", "hooks", "codex", "codex-wrapper.mjs");
		expect(existsSync(wrapperPath)).toBe(false);
	});

	it("appends Kanban sidebar instructions for home Claude sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const appendPromptIndex = launch.args.indexOf("--append-system-prompt");
		expect(appendPromptIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[appendPromptIndex + 1]).toContain("Kanban sidebar agent");
		expect(launch.args[appendPromptIndex + 1]).toContain(
			"'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create",
		);
	});

	it("appends Kanban sidebar instructions for home Codex sessions", async () => {
		setupTempHome();
		setKanbanProcessContext();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		const developerInstructions = getCodexConfigOverrideValues(launch.args, "developer_instructions");
		expect(developerInstructions).toHaveLength(1);
		expect(developerInstructions[0]).toContain("Kanban sidebar agent");
		expect(developerInstructions[0]).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task create");
		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("disables Codex startup update checks for Kanban-launched sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-updates",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["false"]);
	});

	it("preserves an explicit Codex update-check override", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-custom-update-check",
			agentId: "codex",
			binary: "codex",
			args: ["-c", "check_for_update_on_startup=true"],
			cwd: "/tmp",
			prompt: "",
		});

		expect(getCodexConfigOverrideValues(launch.args, "check_for_update_on_startup")).toEqual(["true"]);
	});

	it("writes Claude settings with explicit permission hook", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "claude", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, unknown>;
		};
		expect(settings.hooks?.PermissionRequest).toBeDefined();
		expect(settings.hooks?.PreToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUse).toBeDefined();
		expect(settings.hooks?.PostToolUseFailure).toBeDefined();
	});

	it("writes Gemini settings with AfterTool mapped to to_in_progress", async () => {
		setupTempHome();
		await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const settingsPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
		};
		const afterToolCommand = settings.hooks?.AfterTool?.[0]?.hooks?.[0]?.command;
		expect(afterToolCommand).toContain("hooks");
		expect(afterToolCommand).toContain("gemini-hook");
		const hookScriptPath = join(homedir(), ".cline", "kanban", "hooks", "gemini", "gemini-hook.mjs");
		expect(existsSync(hookScriptPath)).toBe(false);
	});

	it("writes Antigravity hooks in Kanban config and launches with the interactive prompt", async () => {
		const home = setupTempHome();
		const cwd = join(home, "agy-task-worktree");
		mkdirSync(cwd, { recursive: true });
		// Strip GIT_DIR/GIT_INDEX_FILE so a pre-commit hook run cannot redirect these commands to the real repo.
		const env = createGitProcessEnv();
		execFileSync("git", ["init", "-q"], { cwd, env });
		const excludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
			cwd,
			env,
			encoding: "utf8",
		}).trim();
		rmSync(resolve(cwd, excludePath), { force: true });
		const launch = await prepareAgentLaunch({
			taskId: "task-antigravity",
			agentId: "antigravity",
			binary: "agy",
			args: [],
			autonomousModeEnabled: true,
			cwd,
			prompt: "do X",
			workspaceId: "workspace-1",
		});

		expect(launch.args).toContain("--dangerously-skip-permissions");
		const addDirIndexes = launch.args.flatMap((arg, index) => (arg === "--add-dir" ? [index] : []));
		const hooksDirectory = join(cwd, ".agents");
		expect(addDirIndexes).toHaveLength(1);
		const addDirIndex = addDirIndexes[0] ?? -1;
		expect(addDirIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[addDirIndex + 1]).toBe(cwd);
		expect(readFileSync(resolve(cwd, excludePath), "utf8")).toContain(".agents/");
		expect(launch.args.slice(-2)).toEqual(["-i", "do X"]);
		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-antigravity");

		const hooksPath = join(hooksDirectory, "hooks.json");
		const config = JSON.parse(readFileSync(hooksPath, "utf8")) as {
			kanban?: Record<string, Array<{ command?: string; matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		const commands = [
			config.kanban?.SessionStart?.[0]?.command,
			config.kanban?.PreInvocation?.[0]?.command,
			config.kanban?.Stop?.[0]?.command,
			config.kanban?.PreToolUse?.[0]?.hooks?.[0]?.command,
			config.kanban?.PostToolUse?.[0]?.hooks?.[0]?.command,
		];
		expect(config.kanban?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(config.kanban?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(commands.every((command) => command?.includes("antigravity-hook"))).toBe(true);
		expect(readFileSync(hooksPath, "utf8")).toContain("SessionStart");

		const resumed = await prepareAgentLaunch({
			taskId: "task-antigravity-resume",
			agentId: "antigravity",
			binary: "agy",
			args: [],
			cwd,
			prompt: "do X",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});
		expect(resumed.args).toContain("--continue");
	});

	describe("per-task agent model", () => {
		const codexInput = {
			taskId: "task-codex-model",
			agentId: "codex" as const,
			binary: "codex",
			args: [] as string[],
			cwd: "/tmp",
			prompt: "",
		};
		const opencodeInput = {
			agentId: "opencode" as const,
			binary: "opencode",
			args: [] as string[],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		};

		it("passes the Codex model and effort when resolved", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({
				...codexInput,
				agentModel: "gpt-6.1-sol",
				agentReasoningEffort: "high",
				resumeFromTrash: true,
			});
			const modelIndex = launch.args.indexOf("-m");
			expect(launch.args[modelIndex + 1]).toBe("gpt-6.1-sol");
			expect(modelIndex).toBeLessThan(launch.args.indexOf("resume"));
			expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual(["high"]);
			expect(launch.launchedAgentModel).toBe("gpt-6.1-sol");
			expect(launch.launchedAgentReasoningEffort).toBe("high");
		});

		it("adds no Codex model flags when nothing is resolved", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch(codexInput);
			expect(launch.args).not.toContain("-m");
			expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual([]);
			expect(launch.launchedAgentModel).toBeNull();
			expect(launch.launchedAgentReasoningEffort).toBeNull();
		});

		it.each([
			[["-m", "user-model"]],
			[["--model", "user-model"]],
			[["--model=user-model"]],
			[["-c", 'model="user-model"']],
		])("respects user args: model %j", async (args) => {
			setupTempHome();
			const launch = await prepareAgentLaunch({ ...codexInput, args, agentModel: "gpt-6.1-sol" });
			expect(launch.args.join(" ")).not.toContain("gpt-6.1-sol");
			expect(launch.launchedAgentModel).toBe("user-model");
		});

		it("respects user args: a table effort is not applied to the user's own model", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({
				...codexInput,
				args: ["-m", "user-model"],
				agentModel: "gpt-6.1-sol",
				agentReasoningEffort: "high",
			});
			expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual([]);
			expect(launch.launchedAgentReasoningEffort).toBeNull();
		});

		it("respects user args: model_reasoning_effort", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({
				...codexInput,
				args: ["-c", "model_reasoning_effort=low"],
				agentModel: "gpt-6.1-sol",
				agentReasoningEffort: "high",
			});
			expect(getCodexConfigOverrideValues(launch.args, "model_reasoning_effort")).toEqual(["low"]);
			expect(launch.launchedAgentModel).toBe("gpt-6.1-sol");
			expect(launch.launchedAgentReasoningEffort).toBe("low");
		});

		it("does not read a Codex model from the prompt", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({ ...codexInput, prompt: "-mfoo" });
			expect(launch.launchedAgentModel).toBeNull();
		});

		it("writes a task-specific OpenCode config with the model and the plugin", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({
				...opencodeInput,
				taskId: "task-a",
				agentModel: "opencode/free-1",
				agentReasoningEffort: "high",
			});
			const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "opencode");
			const configPath = launch.env.OPENCODE_CONFIG as string;
			expect(configPath).not.toBe(join(hooksDir, "opencode.json"));
			expect(configPath).toContain("task-a");
			const config = JSON.parse(readFileSync(configPath, "utf8")) as { model: string; plugin: string[] };
			expect(config.model).toBe("opencode/free-1");
			expect(config.plugin).toEqual([pathToFileURL(join(hooksDir, "kanban")).href]);
			expect(launch.args).not.toContain("--model");
			expect(launch.launchedAgentModel).toBe("opencode/free-1");
			expect(launch.launchedAgentReasoningEffort).toBeNull();
			await launch.cleanup?.();
			expect(existsSync(configPath)).toBe(false);
		});

		it("gives two OpenCode tasks different config files", async () => {
			setupTempHome();
			const first = await prepareAgentLaunch({ ...opencodeInput, taskId: "task-a", agentModel: "opencode/free-1" });
			const second = await prepareAgentLaunch({ ...opencodeInput, taskId: "task-b", agentModel: "opencode/free-2" });
			expect(first.env.OPENCODE_CONFIG).not.toBe(second.env.OPENCODE_CONFIG);
			const read = (path: unknown) =>
				JSON.parse(readFileSync(path as string, "utf8")) as { model: string; plugin: string[] };
			expect(read(first.env.OPENCODE_CONFIG).model).toBe("opencode/free-1");
			expect(read(second.env.OPENCODE_CONFIG).model).toBe("opencode/free-2");
			expect(read(second.env.OPENCODE_CONFIG).plugin).toHaveLength(1);
		});

		it("keeps the shared OpenCode config without a model", async () => {
			setupTempHome();
			const launch = await prepareAgentLaunch({ ...opencodeInput, taskId: "task-a" });
			const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "opencode");
			expect(launch.env.OPENCODE_CONFIG).toBe(join(hooksDir, "opencode.json"));
			expect(launch.cleanup).toBeUndefined();
			expect(launch.launchedAgentModel).toBeNull();
		});
	});

	it("writes an OpenCode v2 plugin directory and launches with a private server", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Fix the bug",
			workspaceId: "workspace-1",
		});

		expect(launch.args).toEqual(["--auto", "--standalone", "--prompt", "Fix the bug"]);
		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "opencode");
		expect(launch.env.OPENCODE_CONFIG).toBe(join(hooksDir, "opencode.json"));
		const config = JSON.parse(readFileSync(join(hooksDir, "opencode.json"), "utf8")) as { plugin: string[] };
		expect(config.plugin).toEqual([pathToFileURL(join(hooksDir, "kanban")).href]);
		const plugin = readFileSync(join(hooksDir, "kanban", "index.js"), "utf8");
		expect(plugin).toContain('export default { id: "kanban", setup }');
		expect(plugin).toContain("session.execution.succeeded");
	});

	it("does not duplicate an explicit OpenCode --standalone arg", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "opencode",
			binary: "opencode",
			args: ["--standalone"],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.args).toEqual(["--standalone"]);
	});

	it("builds OpenCode v2 TUI args without --model even when OpenCode model state exists", async () => {
		const homePath = setupTempHome();
		const statePath = join(homePath, ".local", "state", "opencode");
		mkdirSync(statePath, { recursive: true });
		writeFileSync(
			join(statePath, "model.json"),
			JSON.stringify({ recent: [{ providerID: "opencode", modelID: "big-pickle" }] }),
			"utf8",
		);

		const launch = await prepareAgentLaunch({
			taskId: "task-opencode-v2-args",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "  Fix the bug  ",
		});

		expect(launch.args).toEqual(["--auto", "--prompt", "Fix the bug"]);
	});

	it("writes Droid settings with hook transitions and runtime autonomy mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "droid",
			binary: "droid",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const settingsArgIndex = launch.args.indexOf("--settings");
		expect(settingsArgIndex).toBeGreaterThanOrEqual(0);
		const settingsPath = launch.args[settingsArgIndex + 1];
		expect(settingsPath).toBeDefined();

		const settings = JSON.parse(readFileSync(settingsPath ?? "", "utf8")) as {
			autonomyMode?: string;
			hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
		};
		expect(settings.autonomyMode).toBe("auto-high");
		expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("activity");
		expect(settings.hooks?.Notification?.[1]?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PreToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const preToolInProgressHook = settings.hooks?.PreToolUse?.find(
			(hook) => hook.matcher === "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create",
		);
		expect(preToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		const preToolReviewHook = settings.hooks?.PreToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(preToolReviewHook?.hooks?.[0]?.command).toContain("to_review");
		expect(settings.hooks?.PostToolUse?.[0]?.matcher).toBe("*");
		expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("activity");
		const postToolInProgressHook = settings.hooks?.PostToolUse?.find((hook) => hook.matcher === "AskUser");
		expect(postToolInProgressHook?.hooks?.[0]?.command).toContain("to_in_progress");
		expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("to_in_progress");
	});

	it("writes Kiro agent hooks and uses a Kanban-managed soft planning prompt", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-kiro-1",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "Investigate deployment drift",
			startInPlanMode: true,
			workspaceId: "workspace-1",
		});

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-kiro-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");
		expect(launch.args).toContain("--agent");
		expect(launch.args[launch.args.indexOf("--agent") + 1]).toBe("kanban");
		expect(launch.args).toContain("--trust-all-tools");
		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Do not modify files");
		expect(initialPrompt).toContain("Task:\nInvestigate deployment drift");

		const configPath = join(homedir(), ".kiro", "agents", "kanban.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			tools?: string[];
			hooks?: Record<string, Array<{ command?: string }>>;
		};
		expect(config.tools).toEqual(["*"]);
		expect(config.hooks?.agentSpawn?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.userPromptSubmit?.[0]?.command).toContain("to_in_progress");
		expect(config.hooks?.preToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.preToolUse?.[1]?.command).toContain("to_in_progress");
		expect(config.hooks?.postToolUse?.[0]?.command).toContain("activity");
		expect(config.hooks?.stop?.[0]?.command).toContain("to_review");
		expect(config.hooks?.stop?.[0]?.command).toContain("Waiting for review");
	});

	it("materializes task images for CLI prompts", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-images",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Inspect the attached design",
			images: [
				{
					id: "img-1",
					data: Buffer.from("hello").toString("base64"),
					mimeType: "image/png",
					name: "diagram.png",
				},
			],
		});

		const initialPrompt = launch.args.at(-1) ?? "";
		expect(initialPrompt).toContain("Attached reference images:");
		expect(initialPrompt).toContain("Task:\nInspect the attached design");

		const imagePathMatch = initialPrompt.match(/1\. (.+?) \(diagram\.png\)/);
		expect(imagePathMatch?.[1]).toBeDefined();
		const imagePath = imagePathMatch?.[1] ?? "";
		expect(existsSync(imagePath)).toBe(true);
		expect(readFileSync(imagePath).toString("utf8")).toBe("hello");
	});

	it("defers Codex plan-mode startup input until startup UI is ready", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "Audit the deployment pipeline",
			startInPlanMode: true,
		});

		expect(launch.args).not.toContain("Audit the deployment pipeline");
		expect(launch.deferredStartupInput).toContain("\u001b[200~");
		expect(launch.deferredStartupInput).toContain("/plan Audit the deployment pipeline");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("defers a bare /plan command when Codex plan mode has no prompt text", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-plan-empty",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});

		expect(launch.deferredStartupInput).toContain("/plan");
		expect(launch.deferredStartupInput).not.toContain("/plan ");
		expect(launch.deferredStartupInput?.endsWith("\r")).toBe(true);
	});

	it("writes Cline hook scripts and injects --hooks-dir", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-1",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			workspaceId: "workspace-1",
		});

		const hooksDir = join(homedir(), ".cline", "kanban", "hooks", "cline");
		const notificationHookPath =
			process.platform === "win32" ? join(hooksDir, "Notification.ps1") : join(hooksDir, "Notification");
		const taskCompleteHookPath =
			process.platform === "win32" ? join(hooksDir, "TaskComplete.ps1") : join(hooksDir, "TaskComplete");
		const userPromptSubmitHookPath =
			process.platform === "win32" ? join(hooksDir, "UserPromptSubmit.ps1") : join(hooksDir, "UserPromptSubmit");
		const preToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PreToolUse.ps1") : join(hooksDir, "PreToolUse");
		const postToolUseHookPath =
			process.platform === "win32" ? join(hooksDir, "PostToolUse.ps1") : join(hooksDir, "PostToolUse");

		expect(launch.env.KANBAN_HOOK_TASK_ID).toBe("task-1");
		expect(launch.env.KANBAN_HOOK_WORKSPACE_ID).toBe("workspace-1");

		const hooksDirArgIndex = launch.args.indexOf("--hooks-dir");
		expect(hooksDirArgIndex).toBeGreaterThanOrEqual(0);
		expect(launch.args[hooksDirArgIndex + 1]).toBe(hooksDir);

		expect(existsSync(notificationHookPath)).toBe(true);
		expect(existsSync(taskCompleteHookPath)).toBe(true);
		expect(existsSync(userPromptSubmitHookPath)).toBe(true);
		expect(existsSync(preToolUseHookPath)).toBe(true);
		expect(existsSync(postToolUseHookPath)).toBe(true);

		const notificationScript = readFileSync(notificationHookPath, "utf8");
		expect(notificationScript).toContain("hooks");
		expect(notificationScript).toContain("to_review");
		expect(notificationScript).toContain("user_attention");
		expect(notificationScript).toContain("completion_result");
		expect(notificationScript).toContain('{"cancel":false}');

		const taskCompleteScript = readFileSync(taskCompleteHookPath, "utf8");
		expect(taskCompleteScript).toContain("hooks");
		expect(taskCompleteScript).toContain("to_review");
		expect(taskCompleteScript).toContain('{"cancel":false}');

		const userPromptSubmitScript = readFileSync(userPromptSubmitHookPath, "utf8");
		expect(userPromptSubmitScript).toContain("hooks");
		expect(userPromptSubmitScript).toContain("to_in_progress");
		expect(userPromptSubmitScript).toContain('{"cancel":false}');

		const preToolUseScript = readFileSync(preToolUseHookPath, "utf8");
		expect(preToolUseScript).toContain("hooks");
		expect(preToolUseScript).toContain("activity");
		expect(preToolUseScript).toContain("to_in_progress");
		expect(preToolUseScript).toContain("to_review");
		expect(preToolUseScript).toContain("ask_followup_question");
		expect(preToolUseScript).toContain("plan_mode_respond");

		const postToolUseScript = readFileSync(postToolUseHookPath, "utf8");
		expect(postToolUseScript).toContain("hooks");
		expect(postToolUseScript).toContain("activity");
		expect(postToolUseScript).toContain("to_in_progress");
		expect(postToolUseScript).toContain("ask_followup_question");
		expect(postToolUseScript).toContain("plan_mode_respond");
	});

	it("adds resume flags for each agent", async () => {
		setupTempHome();

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(codexLaunch.args).toEqual(expect.arrayContaining(["resume", "--last"]));

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(claudeLaunch.args).toContain("--continue");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(geminiLaunch.args).toEqual(expect.arrayContaining(["--resume", "latest"]));

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(opencodeLaunch.args).toContain("--continue");

		const droidLaunch = await prepareAgentLaunch({
			taskId: "task-droid",
			agentId: "droid",
			binary: "droid",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(droidLaunch.args).toContain("--resume");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(kiroLaunch.args).toContain("--resume");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline",
			agentId: "cline",
			binary: "cline",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
		});
		expect(clineLaunch.args).toContain("--continue");
	});

	it("resumes each agent's previous conversation with a continue prompt so it does not sit idle", async () => {
		setupTempHome();
		const prompt = "Kanban was restarted; continue the task where you left off.";
		const cases = [
			{ agentId: "claude", binary: "claude", args: [], resumeArgs: ["--continue"] },
			{ agentId: "codex", binary: "codex", args: [], resumeArgs: ["resume", "--last"] },
			{ agentId: "opencode", binary: "opencode", args: [], resumeArgs: ["--continue", "--prompt"] },
			{ agentId: "cline", binary: "cline", args: [], resumeArgs: ["--continue"] },
			{ agentId: "droid", binary: "droid", args: [], resumeArgs: ["--resume"] },
			{ agentId: "kiro", binary: "kiro-cli", args: ["chat"], resumeArgs: ["--resume"] },
		] as const;
		for (const { agentId, binary, args, resumeArgs } of cases) {
			const launch = await prepareAgentLaunch({
				taskId: `task-${agentId}`,
				agentId,
				binary,
				args: [...args],
				cwd: "/tmp",
				prompt,
				resumeFromTrash: true,
			});
			expect(launch.args, agentId).toEqual(expect.arrayContaining([...resumeArgs]));
			expect([...launch.args, launch.deferredStartupInput ?? ""].join(" "), agentId).toContain(prompt);
		}
	});

	it("places Codex hook config before the resume subcommand", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-codex-resume-hooks",
			agentId: "codex",
			binary: "codex",
			args: [],
			cwd: "/tmp",
			prompt: "",
			resumeFromTrash: true,
			workspaceId: "workspace-1",
		});

		const resumeIndex = launch.args.indexOf("resume");
		expect(resumeIndex).toBeGreaterThan(0);
		for (const key of [
			"features.hooks",
			"hooks.state",
			"hooks.UserPromptSubmit",
			"hooks.Stop",
			"hooks.PermissionRequest",
			"hooks.PreToolUse",
			"hooks.PostToolUse",
		]) {
			const configIndex = launch.args.findIndex((arg) => arg.startsWith(`${key}=`));
			expect(configIndex).toBeGreaterThan(-1);
			expect(configIndex).toBeLessThan(resumeIndex);
		}
	});

	it("applies autonomous mode flags in adapters for non-droid CLIs", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-auto",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		const permissionModeIndex = claudeLaunch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(claudeLaunch.args[permissionModeIndex + 1]).toBe("auto");
		expect(claudeLaunch.args).not.toContain("--dangerously-skip-permissions");
		expect(claudeLaunch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-auto",
			agentId: "codex",
			binary: "codex",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-auto",
			agentId: "gemini",
			binary: "gemini",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-auto",
			agentId: "cline",
			binary: "cline",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode-auto",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(opencodeLaunch.args).toContain("--auto");

		const opencodeExplicitLaunch = await prepareAgentLaunch({
			taskId: "task-opencode-auto-explicit",
			agentId: "opencode",
			binary: "opencode",
			args: ["--auto"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(opencodeExplicitLaunch.args.filter((arg) => arg === "--auto")).toHaveLength(1);
	});

	it("does not add a Claude permission mode when args already set one", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-explicit-mode",
			agentId: "claude",
			binary: "claude",
			args: ["--permission-mode", "acceptEdits"],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
		});
		expect(launch.args.filter((arg) => arg === "--permission-mode")).toHaveLength(1);
		expect(launch.args).not.toContain("auto");
	});

	it("launches a claude task session with the per-task model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-model",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			claudeModel: "haiku",
		});

		expect(launch.args.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("haiku");
	});

	it("keeps a user supplied claude --model without duplicating it", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-model-explicit",
			agentId: "claude",
			binary: "claude",
			args: ["--model", "opus"],
			cwd: "/tmp",
			prompt: "",
			claudeModel: "haiku",
		});

		expect(launch.args.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("opus");
	});

	it("keeps a user supplied custom claude --model instead of the task model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-model-custom",
			agentId: "claude",
			binary: "claude",
			args: ["--model", "custom-x"],
			cwd: "/tmp",
			prompt: "",
			claudeModel: "haiku",
		});

		expect(launch.args.filter((arg) => arg === "--model")).toHaveLength(1);
		expect(launch.args[launch.args.indexOf("--model") + 1]).toBe("custom-x");
	});

	it("does not add a claude --model when the task card has no model", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-no-model",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
		});

		expect(launch.args).not.toContain("--model");
	});

	it("does not add a claude --model for home agent sessions", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "__home_agent__:workspace-1:claude",
			agentId: "claude",
			binary: "claude",
			args: [],
			cwd: "/tmp",
			prompt: "",
			claudeModel: "haiku",
		});

		expect(launch.args).not.toContain("--model");
	});

	it("starts Claude plan mode without bypass flags and keeps auto mode reachable", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan",
			agentId: "claude",
			binary: "claude",
			args: [],
			autonomousModeEnabled: true,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(permissionModeIndex).toBeGreaterThan(-1);
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		expect(launch.env.CLAUDE_CODE_ENABLE_AUTO_MODE).toBe("1");
	});

	it("strips an explicit Claude bypass arg in plan mode", async () => {
		setupTempHome();
		const launch = await prepareAgentLaunch({
			taskId: "task-claude-plan-bypass",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
			startInPlanMode: true,
		});
		expect(launch.args).not.toContain("--dangerously-skip-permissions");
		expect(launch.args).not.toContain("--allow-dangerously-skip-permissions");
		const permissionModeIndex = launch.args.indexOf("--permission-mode");
		expect(launch.args[permissionModeIndex + 1]).toBe("plan");
	});

	it("preserves explicit autonomous args when autonomous mode is disabled", async () => {
		setupTempHome();

		const claudeLaunch = await prepareAgentLaunch({
			taskId: "task-claude-no-auto",
			agentId: "claude",
			binary: "claude",
			args: ["--dangerously-skip-permissions"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(claudeLaunch.args).toContain("--dangerously-skip-permissions");

		const codexLaunch = await prepareAgentLaunch({
			taskId: "task-codex-no-auto",
			agentId: "codex",
			binary: "codex",
			args: ["--dangerously-bypass-approvals-and-sandbox"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(codexLaunch.args).toContain("--dangerously-bypass-approvals-and-sandbox");

		const geminiLaunch = await prepareAgentLaunch({
			taskId: "task-gemini-no-auto",
			agentId: "gemini",
			binary: "gemini",
			args: ["--yolo"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(geminiLaunch.args).toContain("--yolo");

		const clineLaunch = await prepareAgentLaunch({
			taskId: "task-cline-no-auto",
			agentId: "cline",
			binary: "cline",
			args: ["--auto-approve-all"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(clineLaunch.args).toContain("--auto-approve-all");

		const kiroLaunch = await prepareAgentLaunch({
			taskId: "task-kiro-no-auto",
			agentId: "kiro",
			binary: "kiro-cli",
			args: ["chat", "--trust-all-tools"],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(kiroLaunch.args).toContain("--trust-all-tools");

		const opencodeLaunch = await prepareAgentLaunch({
			taskId: "task-opencode-no-auto",
			agentId: "opencode",
			binary: "opencode",
			args: [],
			autonomousModeEnabled: false,
			cwd: "/tmp",
			prompt: "",
		});
		expect(opencodeLaunch.args).not.toContain("--auto");
	});
});

describe("lean task sessions", () => {
	function createLeanFixture(home: string): { cwd: string; leanSkillSet: EffectiveSkillSet } {
		const cwd = join(home, "task-worktree");
		mkdirSync(cwd, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd, env: createGitTestEnv() });
		const skillDir = join(home, "skill-sources", "test-driven-development");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test-driven-development\n---\n");
		return {
			cwd,
			leanSkillSet: { skills: [{ name: "test-driven-development", dir: skillDir }], mcpEnabled: ["cua_repl"] },
		};
	}

	/** A stand-in `codex` that answers the three inventory commands like Codex 0.166. */
	function createFakeCodex(home: string): string {
		const pluginList = JSON.stringify({
			installed: [
				{ pluginId: "ponytail@ponytail", installed: true, enabled: true },
				{ pluginId: "unified-computer-use@openai-bundled", installed: true, enabled: true },
				{ pluginId: "superpowers@openai-curated-remote", installed: true, enabled: true },
				{ pluginId: "disabled@market", installed: true, enabled: false },
			],
			available: [],
		});
		const promptInput = JSON.stringify([
			{
				type: "message",
				content: [
					{
						type: "input_text",
						text: "### Available skills\n- imagegen: Images (file: r2/imagegen/SKILL.md)\n- ponytail:ponytail: Lazy (file: r9/ponytail/SKILL.md)\n",
					},
				],
			},
		]);
		const binary = join(home, "fake-codex");
		writeFileSync(
			binary,
			`#!/bin/sh\ncase "$1 $2" in\n"plugin list") cat <<'EOF'\n${pluginList}\nEOF\n;;\n"debug prompt-input") cat <<'EOF'\n${promptInput}\nEOF\n;;\n*) exit 1;;\nesac\n`,
		);
		chmodSync(binary, 0o755);
		mkdirSync(join(home, ".codex", "plugins", "cache", "openai-bundled", "unified-computer-use", "1.0.0"), {
			recursive: true,
		});
		writeFileSync(
			join(home, ".codex", "plugins", "cache", "openai-bundled", "unified-computer-use", "1.0.0", ".mcp.json"),
			JSON.stringify({ mcpServers: { cua_repl: { command: "/bin/sh" } } }),
		);
		writeFileSync(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.node_repl]\ncommand = "node_repl"\n\n[mcp_servers.node_repl.env]\nA = "1"\n',
		);
		return binary;
	}

	it("codex: delivers the set and adds the plugin, skill and MCP overrides from the fake codex", async () => {
		const home = setupTempHome();
		const { cwd, leanSkillSet } = createLeanFixture(home);
		const binary = createFakeCodex(home);
		const launch = await prepareAgentLaunch({
			taskId: "task-lean-codex",
			agentId: "codex",
			binary,
			args: [],
			cwd,
			prompt: "do X",
			resumeFromTrash: true,
			leanSkillSet,
		});
		const plugins = launch.args.filter((arg) => arg.startsWith("plugins."));
		expect(plugins).toEqual([
			"plugins.ponytail@ponytail.enabled=false",
			"plugins.superpowers@openai-curated-remote.enabled=false",
		]);
		expect(getCodexConfigOverrideValues(launch.args, "skills.bundled.enabled")).toEqual(["false"]);
		expect(getCodexConfigOverrideValues(launch.args, "skills.config")).toEqual([
			'[{name="imagegen",enabled=false},{name="ponytail:ponytail",enabled=false}]',
		]);
		expect(getCodexConfigOverrideValues(launch.args, "mcp_servers.node_repl.enabled")).toEqual(["false"]);
		// Overrides go before the `resume` subcommand.
		expect(launch.args.indexOf("resume")).toBeGreaterThan(
			launch.args.lastIndexOf("mcp_servers.node_repl.enabled=false"),
		);
		expect(existsSync(join(cwd, ".agents", "skills", "test-driven-development", "SKILL.md"))).toBe(true);
	});

	it("opencode without a model: writes a per-task config with permission.skill and leaves the shared file alone", async () => {
		const home = setupTempHome();
		const { cwd, leanSkillSet } = createLeanFixture(home);
		const opencodeInput = {
			agentId: "opencode" as const,
			binary: "opencode",
			args: [] as string[],
			cwd,
			prompt: "",
			workspaceId: "workspace-1",
		};
		await prepareAgentLaunch({ ...opencodeInput, taskId: "task-plain" });
		const sharedPath = join(home, ".cline", "kanban", "hooks", "opencode", "opencode.json");
		const sharedBefore = readFileSync(sharedPath);

		const launch = await prepareAgentLaunch({ ...opencodeInput, taskId: "task-lean", leanSkillSet });
		const configPath = launch.env.OPENCODE_CONFIG as string;
		expect(configPath).not.toBe(sharedPath);
		expect(configPath).toContain("task-lean");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			plugin: string[];
			model?: string;
			permission: { skill: Record<string, string> };
		};
		expect(config.permission.skill).toEqual({ "*": "deny", "test-driven-development": "allow" });
		expect(config.model).toBeUndefined();
		expect(config.plugin).toHaveLength(1);
		expect(readFileSync(sharedPath).equals(sharedBefore)).toBe(true);
		expect(existsSync(join(cwd, ".opencode", "skills", "test-driven-development", "SKILL.md"))).toBe(true);
		await launch.cleanup?.();
		expect(existsSync(configPath)).toBe(false);
	});

	it("antigravity: delivers the set into .agents/skills and adds no switches", async () => {
		const home = setupTempHome();
		const { cwd, leanSkillSet } = createLeanFixture(home);
		const input = {
			taskId: "task-agy",
			agentId: "antigravity" as const,
			binary: "agy",
			args: [],
			cwd,
			prompt: "do X",
		};
		const plain = await prepareAgentLaunch(input);
		const lean = await prepareAgentLaunch({ ...input, leanSkillSet });
		expect(lean.args).toEqual(plain.args);
		expect(lean.env).toEqual(plain.env);
		expect(existsSync(join(cwd, ".agents", "skills", "test-driven-development", "SKILL.md"))).toBe(true);
	});
});
