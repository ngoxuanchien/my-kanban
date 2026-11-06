import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type {
	RuntimeAgentId,
	RuntimeClaudeModel,
	RuntimeHookEvent,
	RuntimeTaskImage,
	RuntimeTaskSessionSummary,
} from "../core/api-contract";
import type { EffectiveSkillSet } from "../core/employee-skill-set";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { buildKanbanCommandParts } from "../core/kanban-command";
import { quoteShellArg } from "../core/shell";
import { lockedFileSystem } from "../fs/locked-file-system";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { getRuntimeHomePath } from "../state/workspace-state";
import { configureCodexHooks, hasCodexConfigOverride } from "./codex-hook-config";
import { createHookRuntimeEnv } from "./hook-runtime-context";
import { stripAnsi } from "./output-utils";
import type { SessionTransitionEvent } from "./session-state-machine";
import { prepareTaskPromptWithImages } from "./task-image-prompt";
import {
	appendGitExcludeLines,
	buildCodexLeanOverrides,
	buildOpencodeLeanConfig,
	deliverTaskSkills,
	loadCodexLeanInventory,
} from "./task-skill-delivery";

export interface AgentAdapterLaunchInput {
	taskId: string;
	agentId: RuntimeAgentId;
	binary?: string;
	args: string[];
	autonomousModeEnabled?: boolean;
	cwd: string;
	prompt: string;
	images?: RuntimeTaskImage[];
	startInPlanMode?: boolean;
	resumeFromTrash?: boolean;
	env?: Record<string, string | undefined>;
	workspaceId?: string;
	claudeModel?: RuntimeClaudeModel;
	agentModel?: string;
	agentReasoningEffort?: string;
	/** Lean session: deliver these skills and turn the rest off. Absent = launch exactly as before. */
	leanSkillSet?: EffectiveSkillSet;
}

export type AgentOutputTransitionDetector = (
	data: string,
	summary: RuntimeTaskSessionSummary,
) => SessionTransitionEvent | null;

export type AgentOutputTransitionInspectionPredicate = (summary: RuntimeTaskSessionSummary) => boolean;

export interface PreparedAgentLaunch {
	binary?: string;
	args: string[];
	env: Record<string, string | undefined>;
	cleanup?: () => Promise<void>;
	deferredStartupInput?: string;
	detectOutputTransition?: AgentOutputTransitionDetector;
	shouldInspectOutputForTransition?: AgentOutputTransitionInspectionPredicate;
	/** Codex/OpenCode model and effort this launch really uses, user agent args included. */
	launchedAgentModel?: string | null;
	launchedAgentReasoningEffort?: string | null;
}

interface HookContext {
	taskId: string;
	workspaceId: string;
}

interface HookCommandMetadata {
	source?: string;
	activityText?: string;
	hookEventName?: string;
	notificationType?: string;
}

interface AgentSessionAdapter {
	prepare(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch>;
}

function powerShellQuote(value: string): string {
	return `"${value.replaceAll("`", "``").replaceAll('"', '`"')}"`;
}

function resolveHookContext(input: AgentAdapterLaunchInput): HookContext | null {
	const workspaceId = input.workspaceId?.trim();
	if (!workspaceId) {
		return null;
	}
	return {
		taskId: input.taskId,
		workspaceId,
	};
}

function buildHookCommand(event: RuntimeHookEvent, metadata?: HookCommandMetadata): string {
	const parts = buildHooksCommandParts(["ingest", "--event", event]);
	if (metadata?.source) {
		parts.push("--source", metadata.source);
	}
	if (metadata?.activityText) {
		parts.push("--activity-text", metadata.activityText);
	}
	if (metadata?.hookEventName) {
		parts.push("--hook-event-name", metadata.hookEventName);
	}
	if (metadata?.notificationType) {
		parts.push("--notification-type", metadata.notificationType);
	}
	return parts.map(quoteShellArg).join(" ");
}

function buildHooksCommandParts(args: string[]): string[] {
	return buildKanbanCommandParts(["hooks", ...args]);
}

function buildHooksCommand(args: string[]): string {
	return buildHooksCommandParts(args).map(quoteShellArg).join(" ");
}

function hasCliOption(args: string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

function getClineHookScriptPath(
	hooksDir: string,
	hookName: "Notification" | "TaskComplete" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse",
): string {
	if (process.platform === "win32") {
		return join(hooksDir, `${hookName}.ps1`);
	}
	return join(hooksDir, hookName);
}

function buildClineHookScriptContent(event: RuntimeHookEvent): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", event, "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
try {
  $inputText | & ${command} | Out-Null
} catch {
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
echo '{"cancel":false}'
`;
}

function buildClineNotificationHookScriptContent(): string {
	const commandParts = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	if (process.platform === "win32") {
		const command = commandParts.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
if (
  $inputText -match '"event"\\s*:\\s*"user_attention"' -and
  $inputText -notmatch '"source"\\s*:\\s*"completion_result"'
) {
  try {
    $inputText | & ${command} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const command = commandParts.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
if printf '%s' "$INPUT" | grep -Eq '"event"[[:space:]]*:[[:space:]]*"user_attention"' &&
  ! printf '%s' "$INPUT" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"completion_result"'; then
  printf '%s' "$INPUT" | ${command} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePreToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const reviewCommand = buildHooksCommandParts(["notify", "--event", "to_review", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const review = reviewCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${review} | Out-Null
  } catch {
  }
} else {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const review = reviewCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${review} >/dev/null 2>&1 || true
else
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

function buildClinePostToolUseHookScriptContent(): string {
	const activityCommand = buildHooksCommandParts(["notify", "--event", "activity", "--source", "cline"]);
	const inProgressCommand = buildHooksCommandParts(["notify", "--event", "to_in_progress", "--source", "cline"]);
	if (process.platform === "win32") {
		const activity = activityCommand.map(powerShellQuote).join(" ");
		const inProgress = inProgressCommand.map(powerShellQuote).join(" ");
		return `$inputText = [Console]::In.ReadToEnd()
$isUserQuestionTool = $inputText -match '"(toolName|tool)"\\s*:\\s*"(ask_followup_question|plan_mode_respond)"'
try {
  $inputText | & ${activity} | Out-Null
} catch {
}
if ($isUserQuestionTool) {
  try {
    $inputText | & ${inProgress} | Out-Null
  } catch {
  }
}
Write-Output '{"cancel":false}'
exit 0
`;
	}
	const activity = activityCommand.map(quoteShellArg).join(" ");
	const inProgress = inProgressCommand.map(quoteShellArg).join(" ");
	return `#!/usr/bin/env bash
INPUT="$(cat || true)"
printf '%s' "$INPUT" | ${activity} >/dev/null 2>&1 || true
if printf '%s' "$INPUT" | grep -Eq '"(toolName|tool)"[[:space:]]*:[[:space:]]*"(ask_followup_question|plan_mode_respond)"'; then
  printf '%s' "$INPUT" | ${inProgress} >/dev/null 2>&1 || true
fi
echo '{"cancel":false}'
`;
}

// OpenCode v2 server plugin. v2 only loads plugin directories and runs plugins in its server process, which is
// only the per-task process (inheriting KANBAN_HOOK_* env) when the TUI is launched with --standalone.
function buildOpenCodePluginContent(
	reviewCommand: string,
	toInProgressCommand: string,
	activityCommand: string,
): string {
	return `import { exec } from "node:child_process";

const COMMANDS = {
  review: ${JSON.stringify(reviewCommand)},
  in_progress: ${JSON.stringify(toInProgressCommand)},
  activity: ${JSON.stringify(activityCommand)},
};
// --auto replies to permission requests within milliseconds; only a request still pending after this needs the user.
const PERMISSION_REVIEW_DELAY_MS = 500;

const notify = (kind, payload) =>
  new Promise((resolve) => {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    // Best effort: hook errors should never break OpenCode event handling.
    const child = exec(COMMANDS[kind] + " --metadata-base64 " + encoded, () => resolve());
    // \`kanban hooks ingest\` reads stdin until EOF.
    child.stdin?.end();
  });

const setup = async (ctx) => {
  const noop = async () => {};
  if (!process.env.KANBAN_HOOK_TASK_ID || typeof ctx?.event?.subscribe !== "function") return noop;

  let currentState = "idle";
  // The first session to start executing is the root; subagent sessions only run inside its execution.
  let rootSessionID = null;
  let lastAssistantMessage;
  let pendingPermission = null;
  const toolNameByCallID = new Map();

  const handleBusy = async (sessionID) => {
    if (!rootSessionID) rootSessionID = sessionID;
    if (sessionID !== rootSessionID || currentState !== "idle") return;
    currentState = "busy";
    lastAssistantMessage = undefined;
    await notify("in_progress", { hook_event_name: "session.status" });
  };

  const handleReview = async (sessionID, payload, force = false) => {
    if (sessionID !== rootSessionID) return;
    if (!force && currentState !== "busy") return;
    currentState = "idle";
    rootSessionID = null;
    await notify("review", { ...payload, last_assistant_message: lastAssistantMessage });
  };

  const clearPendingPermission = () => {
    if (!pendingPermission) return false;
    clearTimeout(pendingPermission);
    pendingPermission = null;
    return true;
  };

  const handleEvent = async (type, data) => {
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : null;
    if (!sessionID) return;
    if (type === "session.execution.started") {
      await handleBusy(sessionID);
      return;
    }
    if (rootSessionID && sessionID !== rootSessionID) return;

    if (type === "session.text.ended" && typeof data.text === "string" && data.text.trim()) {
      lastAssistantMessage = data.text.trim();
    } else if (type === "session.tool.input.started" && typeof data.id === "string") {
      toolNameByCallID.set(data.id, data.name);
    } else if (type === "session.tool.called") {
      await notify("activity", { hook_event_name: "BeforeTool", tool_name: toolNameByCallID.get(data.id), tool_input: data.input });
    } else if (type === "session.tool.success") {
      await notify("activity", { hook_event_name: "AfterTool", tool_name: toolNameByCallID.get(data.id) });
      toolNameByCallID.delete(data.id);
    } else if (type === "permission.asked") {
      clearPendingPermission();
      pendingPermission = setTimeout(() => {
        pendingPermission = null;
        void notify("activity", { hook_event_name: "PermissionRequest", notification_type: "permission.asked" });
      }, PERMISSION_REVIEW_DELAY_MS);
    } else if (type === "permission.replied") {
      clearPendingPermission();
    } else if (type === "session.execution.succeeded" || type === "session.execution.interrupted") {
      clearPendingPermission();
      await handleReview(sessionID, { hook_event_name: "session.idle" });
    } else if (type === "session.execution.failed") {
      clearPendingPermission();
      await handleReview(sessionID, { hook_event_name: "session.error" }, true);
    }
  };

  const controller = new AbortController();
  void (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      await handleEvent(event?.type, event?.data);
    }
  })().catch(() => {});
  return async () => {
    controller.abort();
    clearPendingPermission();
  };
};

export default { id: "kanban", setup };
`;
}

function getHookAgentDirectory(agentId: RuntimeAgentId): string {
	return join(getRuntimeHomePath(), "hooks", agentId);
}

const KIRO_KANBAN_AGENT_NAME = "kanban";

function getKiroAgentConfigPath(): string {
	return join(homedir(), ".kiro", "agents", `${KIRO_KANBAN_AGENT_NAME}.json`);
}

async function ensureTextFile(filePath: string, content: string, executable = false): Promise<void> {
	await lockedFileSystem.writeTextFileAtomic(filePath, content, {
		executable,
	});
}

function withPrompt(args: string[], prompt: string, mode: "append" | "flag", flag?: string): PreparedAgentLaunch {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

function toBracketedPasteSubmission(command: string): string {
	return `\u001b[200~${command}\u001b[201~\r`;
}

const claudeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {
			FORCE_HYPERLINK: "1",
		};
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (input.autonomousModeEnabled) {
			// Auto mode is gated behind this env var on Bedrock/Vertex/Foundry; the Anthropic API ignores it.
			env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
		}
		if (
			input.autonomousModeEnabled &&
			!input.startInPlanMode &&
			!hasCliOption(args, "--permission-mode") &&
			!hasCliOption(args, "--dangerously-skip-permissions")
		) {
			args.push("--permission-mode", "auto");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		if (input.claudeModel !== undefined && !isHomeAgentSessionId(input.taskId) && !hasCliOption(args, "--model")) {
			args.push("--model", input.claudeModel);
		}
		if (input.startInPlanMode) {
			const withoutImmediateBypass = args.filter((arg) => arg !== "--dangerously-skip-permissions");
			args.length = 0;
			args.push(...withoutImmediateBypass);
			args.push("--permission-mode", "plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const settingsPath = join(getHookAgentDirectory("claude"), "settings.json");
			const hooksSettings = {
				hooks: {
					Stop: [{ hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }] }],
					SubagentStop: [
						{ hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }] },
					],
					PreToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					PermissionRequest: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
					],
					PostToolUse: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					PostToolUseFailure: [
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
					Notification: [
						{
							matcher: "permission_prompt",
							hooks: [{ type: "command", command: buildHookCommand("to_review", { source: "claude" }) }],
						},
						{
							matcher: "*",
							hooks: [{ type: "command", command: buildHookCommand("activity", { source: "claude" }) }],
						},
					],
					UserPromptSubmit: [
						{
							hooks: [{ type: "command", command: buildHookCommand("to_in_progress", { source: "claude" }) }],
						},
					],
				},
			};
			await ensureTextFile(settingsPath, JSON.stringify(hooksSettings, null, 2));
			args.push("--settings", settingsPath);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

function codexPromptDetector(data: string, summary: RuntimeTaskSessionSummary): SessionTransitionEvent | null {
	if (summary.state !== "awaiting_review") {
		return null;
	}
	if (summary.reviewReason !== "attention" && summary.reviewReason !== "hook") {
		return null;
	}
	const stripped = stripAnsi(data);
	if (/(?:^|\n)\s*›/.test(stripped)) {
		return { type: "agent.prompt-ready" };
	}
	return null;
}

function shouldInspectCodexOutputForTransition(summary: RuntimeTaskSessionSummary): boolean {
	return (
		summary.state === "awaiting_review" &&
		(summary.reviewReason === "attention" || summary.reviewReason === "hook" || summary.reviewReason === "error")
	);
}

function unquoteTomlString(value: string): string {
	return value.replace(/^["']|["']$/gu, "");
}

function readCodexLaunchedModel(args: string[]): { model: string | null; reasoningEffort: string | null } {
	let model: string | null = null;
	let reasoningEffort: string | null = null;
	const readOverride = (override: string | undefined) => {
		if (override?.startsWith("model=")) model = unquoteTomlString(override.slice("model=".length));
		if (override?.startsWith("model_reasoning_effort=")) {
			reasoningEffort = unquoteTomlString(override.slice("model_reasoning_effort=".length));
		}
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "-m" || arg === "--model") {
			index += 1;
			model = args[index] ?? null;
		} else if (arg?.startsWith("--model=") || arg?.startsWith("-m=")) {
			model = arg.slice(arg.indexOf("=") + 1);
		} else if (arg === "-c" || arg === "--config") {
			index += 1;
			readOverride(args[index]);
		} else if (arg?.startsWith("--config=")) {
			readOverride(arg.slice("--config=".length));
		} else if (arg?.startsWith("-c")) {
			readOverride(arg.slice("-c".length));
		}
	}
	return { model, reasoningEffort };
}

const codexAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const codexArgs = [...input.args];
		const env: Record<string, string | undefined> = {};
		const binary = input.binary;
		let deferredStartupInput: string | undefined;
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);

		if (!hasCodexConfigOverride(codexArgs, "check_for_update_on_startup")) {
			codexArgs.push("-c", "check_for_update_on_startup=false");
		}

		const userSetModel =
			hasCliOption(codexArgs, "-m") ||
			hasCliOption(codexArgs, "--model") ||
			hasCodexConfigOverride(codexArgs, "model");
		if (input.agentModel && !userSetModel) {
			codexArgs.push("-m", input.agentModel);
		}
		// The resolved effort was chosen for the resolved model, so it does not carry over to the user's own model.
		if (input.agentReasoningEffort && !userSetModel && !hasCodexConfigOverride(codexArgs, "model_reasoning_effort")) {
			codexArgs.push("-c", `model_reasoning_effort=${input.agentReasoningEffort}`);
		}
		const launched = readCodexLaunchedModel(codexArgs);

		if (input.leanSkillSet) {
			await deliverTaskSkills({ cwd: input.cwd, agentId: "codex", skills: input.leanSkillSet.skills });
			const inventory = await loadCodexLeanInventory(binary ?? "codex", homedir());
			codexArgs.push(...buildCodexLeanOverrides(inventory, input.leanSkillSet));
		}

		if (input.autonomousModeEnabled && !hasCliOption(codexArgs, "--dangerously-bypass-approvals-and-sandbox")) {
			codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
		}

		if (input.resumeFromTrash) {
			if (!codexArgs.includes("resume")) {
				codexArgs.push("resume");
			}
			if (!hasCliOption(codexArgs, "--last")) {
				codexArgs.push("--last");
			}
		}

		if (appendedSystemPrompt && !hasCodexConfigOverride(codexArgs, "developer_instructions")) {
			codexArgs.push("-c", `developer_instructions=${JSON.stringify(appendedSystemPrompt)}`);
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			configureCodexHooks(codexArgs);
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const trimmed = input.prompt.trim();
		if (input.startInPlanMode) {
			const planCommand = trimmed ? `/plan ${trimmed}` : "/plan";
			deferredStartupInput = toBracketedPasteSubmission(planCommand);
		} else if (trimmed) {
			codexArgs.push(trimmed);
		}

		if (hooks) {
			return {
				binary,
				args: codexArgs,
				env,
				deferredStartupInput,
				detectOutputTransition: codexPromptDetector,
				shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
				launchedAgentModel: launched.model,
				launchedAgentReasoningEffort: launched.reasoningEffort,
			};
		}

		return {
			binary,
			args: codexArgs,
			env,
			deferredStartupInput,
			detectOutputTransition: codexPromptDetector,
			shouldInspectOutputForTransition: shouldInspectCodexOutputForTransition,
			launchedAgentModel: launched.model,
			launchedAgentReasoningEffort: launched.reasoningEffort,
		};
	},
};

const geminiAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--yolo")) {
			args.push("--yolo");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume")) {
			args.push("--resume", "latest");
		}

		if (input.startInPlanMode) {
			args.push("--approval-mode=plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const configPath = join(getHookAgentDirectory("gemini"), "settings.json");
			const geminiHookCommand = buildHooksCommand(["gemini-hook"]);

			const config = {
				hooks: {
					BeforeTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterTool: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					AfterAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					BeforeAgent: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
					Notification: [
						{
							hooks: [{ type: "command", command: geminiHookCommand }],
						},
					],
				},
			};
			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configPath;
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
			return {
				args,
				env,
			};
		}

		return {
			args,
			env,
		};
	},
};

const antigravityAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		if (input.autonomousModeEnabled && !hasCliOption(args, "--dangerously-skip-permissions")) {
			args.push("--dangerously-skip-permissions");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}
		// Delivery only: agy has no per-session skill or MCP switch (spike, contexte/employee-skill-sets.md).
		if (input.leanSkillSet) {
			await deliverTaskSkills({ cwd: input.cwd, agentId: "antigravity", skills: input.leanSkillSet.skills });
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const hooksDirectory = join(input.cwd, ".agents");
			await appendGitExcludeLines(input.cwd, [".agents/"]);
			const hook = (event: string) => ({
				type: "command",
				command: buildHooksCommand(["antigravity-hook", "--event", event]),
			});
			const config = {
				kanban: {
					SessionStart: [hook("SessionStart")],
					PreInvocation: [hook("PreInvocation")],
					Stop: [hook("Stop")],
					PreToolUse: [{ matcher: "*", hooks: [hook("PreToolUse")] }],
					PostToolUse: [{ matcher: "*", hooks: [hook("PostToolUse")] }],
				},
			};
			await ensureTextFile(join(hooksDirectory, "hooks.json"), JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--add-dir")) {
				args.push("--add-dir", input.cwd);
			}
			Object.assign(env, createHookRuntimeEnv({ taskId: hooks.taskId, workspaceId: hooks.workspaceId }));
		}

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("-i", trimmed);
		}
		return { args, env };
	},
};

function hasOpenCodeAgentArg(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--agent") {
			return true;
		}
		if (arg.startsWith("--agent=")) {
			return true;
		}
	}
	return false;
}

const opencodeAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};
		if (input.autonomousModeEnabled && !hasCliOption(args, "--auto")) {
			args.push("--auto");
		}
		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			env.OPENCODE_EXPERIMENTAL_PLAN_MODE = "true";
			if (!hasOpenCodeAgentArg(args)) {
				args.push("--agent", "plan");
			}
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const pluginDirectory = join(getHookAgentDirectory("opencode"), "kanban");
			const configPath = join(getHookAgentDirectory("opencode"), "opencode.json");

			const pluginContent = buildOpenCodePluginContent(
				buildHookCommand("to_review", { source: "opencode" }),
				buildHookCommand("to_in_progress", { source: "opencode" }),
				buildHookCommand("activity", { source: "opencode" }),
			);
			await ensureTextFile(join(pluginDirectory, "index.js"), pluginContent);
			const config = {
				plugin: [pathToFileURL(pluginDirectory).href],
			};
			await ensureTextFile(configPath, JSON.stringify(config));
			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
			env.OPENCODE_CONFIG = configPath;
			// The shared background service would run the plugin without this task's KANBAN_HOOK_* env.
			if (!hasCliOption(args, "--standalone")) {
				args.push("--standalone");
			}
		}

		// No --model: OpenCode v2's TUI rejects it (only `opencode run` has it), so a per-task config carries the model.
		// A lean session also needs its own file: the shared hook config is used by every task and is never changed.
		let cleanup: (() => Promise<void>) | undefined;
		if (input.leanSkillSet) {
			await deliverTaskSkills({ cwd: input.cwd, agentId: "opencode", skills: input.leanSkillSet.skills });
		}
		if (input.agentModel || input.leanSkillSet) {
			// Unique per launch: a restart's new file cannot be removed by the stopped session's cleanup.
			const taskConfigPath = join(
				getHookAgentDirectory("opencode"),
				"tasks",
				`${encodeURIComponent(input.taskId)}-${randomUUID()}.json`,
			);
			const plugin = hooks ? [pathToFileURL(join(getHookAgentDirectory("opencode"), "kanban")).href] : [];
			const lean = input.leanSkillSet ? await buildOpencodeLeanConfig(input.leanSkillSet, homedir()) : {};
			await ensureTextFile(taskConfigPath, JSON.stringify({ plugin, model: input.agentModel, ...lean }));
			env.OPENCODE_CONFIG = taskConfigPath;
			cleanup = () => rm(taskConfigPath, { force: true });
		}
		const launched = {
			...(cleanup ? { cleanup } : {}),
			launchedAgentModel: input.agentModel ?? null,
			launchedAgentReasoningEffort: null,
		};

		const trimmed = input.prompt.trim();
		if (trimmed) {
			args.push("--prompt", trimmed);
			return {
				args,
				env,
				...launched,
			};
		}

		return {
			args,
			env,
			...launched,
		};
	},
};

const droidAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const shouldWriteSettings = Boolean(hooks) || input.startInPlanMode || input.autonomousModeEnabled !== undefined;
		if (shouldWriteSettings) {
			const settingsPath = join(getHookAgentDirectory("droid"), "settings.json");
			const settings: Record<string, unknown> = {
				autonomyMode: input.startInPlanMode ? "spec" : input.autonomousModeEnabled ? "auto-high" : "normal",
			};

			if (hooks) {
				const droidActiveToolMatcher = "Read|Grep|Glob|FetchUrl|WebSearch|Execute|Task|Edit|Create";
				const reviewNotifyCommand = buildHooksCommand(["notify", "--event", "to_review", "--source", "droid"]);
				const inProgressNotifyCommand = buildHooksCommand([
					"notify",
					"--event",
					"to_in_progress",
					"--source",
					"droid",
				]);
				const activityNotifyCommand = buildHooksCommand(["notify", "--event", "activity", "--source", "droid"]);
				settings.hooks = {
					Stop: [{ hooks: [{ type: "command", command: reviewNotifyCommand }] }],
					Notification: [
						{ hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PreToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: droidActiveToolMatcher, hooks: [{ type: "command", command: inProgressNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: reviewNotifyCommand }] },
					],
					PostToolUse: [
						{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] },
						{ matcher: "AskUser", hooks: [{ type: "command", command: inProgressNotifyCommand }] },
					],
					PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command: activityNotifyCommand }] }],
					UserPromptSubmit: [{ hooks: [{ type: "command", command: inProgressNotifyCommand }] }],
				};

				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			await ensureTextFile(settingsPath, JSON.stringify(settings, null, 2));
			if (!hasCliOption(args, "--settings")) {
				args.push("--settings", settingsPath);
			}
		}

		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (
			appendedSystemPrompt &&
			!hasCliOption(args, "--append-system-prompt") &&
			!hasCliOption(args, "--system-prompt")
		) {
			args.push("--append-system-prompt", appendedSystemPrompt);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const kiroAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--trust-all-tools")) {
			args.push("--trust-all-tools");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--resume") && !hasCliOption(args, "-r")) {
			args.push("--resume");
		}

		const hooks = resolveHookContext(input);
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (hooks || appendedSystemPrompt) {
			const configPath = getKiroAgentConfigPath();
			const config: Record<string, unknown> = {
				name: KIRO_KANBAN_AGENT_NAME,
				description: "Kanban-managed Kiro agent with hook forwarding.",
				tools: ["*"],
			};

			if (hooks) {
				config.hooks = {
					agentSpawn: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "agentSpawn",
							}),
						},
					],
					userPromptSubmit: [
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "userPromptSubmit",
							}),
						},
					],
					preToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
						{
							command: buildHookCommand("to_in_progress", {
								source: "kiro",
								hookEventName: "preToolUse",
							}),
						},
					],
					postToolUse: [
						{
							command: buildHookCommand("activity", {
								source: "kiro",
								hookEventName: "postToolUse",
							}),
						},
					],
					stop: [
						{
							command: buildHookCommand("to_review", {
								source: "kiro",
								hookEventName: "stop",
								activityText: "Waiting for review",
							}),
						},
					],
				};
				Object.assign(
					env,
					createHookRuntimeEnv({
						taskId: hooks.taskId,
						workspaceId: hooks.workspaceId,
					}),
				);
			}

			if (appendedSystemPrompt) {
				config.prompt = appendedSystemPrompt;
			}

			await ensureTextFile(configPath, JSON.stringify(config, null, 2));
			if (!hasCliOption(args, "--agent")) {
				args.push("--agent", KIRO_KANBAN_AGENT_NAME);
			}
		}

		const trimmedPrompt = input.prompt.trim();
		const planPrompt = input.startInPlanMode
			? [
					"First, inspect the codebase and produce a clear implementation plan only.",
					"Do not modify files, do not use write tools, and do not implement anything yet.",
					"After you present the plan, ask for approval before making changes.",
					trimmedPrompt
						? `\n\nTask:\n${trimmedPrompt}`
						: " Ask the user what they want planned if the task is unclear.",
				].join(" ")
			: input.prompt;
		const withPromptLaunch = withPrompt(args, planPrompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const clineAdapter: AgentSessionAdapter = {
	async prepare(input) {
		const args = [...input.args];
		const env: Record<string, string | undefined> = {};

		if (input.autonomousModeEnabled && !hasCliOption(args, "--auto-approve-all")) {
			args.push("--auto-approve-all");
		}

		if (input.resumeFromTrash && !hasCliOption(args, "--continue")) {
			args.push("--continue");
		}

		if (input.startInPlanMode) {
			args.push("--plan");
		}

		const hooks = resolveHookContext(input);
		if (hooks) {
			const hooksDir = getHookAgentDirectory("cline");
			const notificationHookPath = getClineHookScriptPath(hooksDir, "Notification");
			const taskCompleteHookPath = getClineHookScriptPath(hooksDir, "TaskComplete");
			const userPromptSubmitHookPath = getClineHookScriptPath(hooksDir, "UserPromptSubmit");
			const preToolUseHookPath = getClineHookScriptPath(hooksDir, "PreToolUse");
			const postToolUseHookPath = getClineHookScriptPath(hooksDir, "PostToolUse");
			const executable = process.platform !== "win32";

			await ensureTextFile(notificationHookPath, buildClineNotificationHookScriptContent(), executable);
			await ensureTextFile(taskCompleteHookPath, buildClineHookScriptContent("to_review"), executable);
			await ensureTextFile(userPromptSubmitHookPath, buildClineHookScriptContent("to_in_progress"), executable);
			await ensureTextFile(preToolUseHookPath, buildClinePreToolUseHookScriptContent(), executable);
			await ensureTextFile(postToolUseHookPath, buildClinePostToolUseHookScriptContent(), executable);

			if (!hasCliOption(args, "--hooks-dir")) {
				args.push("--hooks-dir", hooksDir);
			}

			Object.assign(
				env,
				createHookRuntimeEnv({
					taskId: hooks.taskId,
					workspaceId: hooks.workspaceId,
				}),
			);
		}

		const withPromptLaunch = withPrompt(args, input.prompt, "append");
		return {
			...withPromptLaunch,
			env: {
				...withPromptLaunch.env,
				...env,
			},
		};
	},
};

const ADAPTERS: Record<RuntimeAgentId, AgentSessionAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
	gemini: geminiAdapter,
	antigravity: antigravityAdapter,
	opencode: opencodeAdapter,
	droid: droidAdapter,
	kiro: kiroAdapter,
	cline: clineAdapter,
};

export async function prepareAgentLaunch(input: AgentAdapterLaunchInput): Promise<PreparedAgentLaunch> {
	const preparedPrompt = await prepareTaskPromptWithImages({
		prompt: input.prompt,
		images: input.images,
	});
	return await ADAPTERS[input.agentId].prepare({
		...input,
		prompt: preparedPrompt,
	});
}
