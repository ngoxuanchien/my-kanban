import type { RuntimeTaskSessionSummary } from "../core/api-contract";

// Cline SDK sessions that run the reviewer use this task-id prefix. They are not task sessions.
export const AGENT_REVIEW_SESSION_KEY_PREFIX = "agent-review:";

export type TurnEndKind = "turn_end" | "needs_user" | "other";

// Hook event names that mean the agent finished its turn. See the hook wiring in
// src/terminal/agent-session-adapters.ts, src/commands/hooks.ts and src/commands/hook-events/.
const TURN_END_HOOK_EVENTS = new Set([
	"Stop", // claude, droid
	"stop", // kiro
	"SubagentStop",
	"TaskComplete", // cline CLI
	"AfterAgent", // gemini
	"task_complete", // codex
	"agent_message", // codex final answer
	"session.idle", // opencode
	"session.status", // opencode idle status
	"agent_end", // native Cline SDK
]);

const SOURCES_WITHOUT_TURN_END_EVENT_NAME = new Set(["codex", "opencode"]);

const NEEDS_USER_HOOK_EVENTS = new Set(["PermissionRequest", "Notification"]);
const NEEDS_USER_NOTIFICATION_TYPES = new Set(["user_attention", "permission_prompt", "permission.asked"]);

export function classifyTurnEnd(summary: RuntimeTaskSessionSummary): TurnEndKind {
	if (summary.state !== "awaiting_review") {
		return "other";
	}
	if (summary.reviewReason === "attention") {
		return "needs_user";
	}
	if (summary.reviewReason === "exit") {
		return summary.exitCode === 0 ? "turn_end" : "other";
	}
	if (summary.reviewReason !== "hook" || !summary.latestHookActivity) {
		return "other";
	}
	const { hookEventName, notificationType, source, toolName } = summary.latestHookActivity;
	if (
		(hookEventName && NEEDS_USER_HOOK_EVENTS.has(hookEventName)) ||
		(hookEventName && /(^|_)approval_request(ed)?$/.test(hookEventName)) ||
		(notificationType && NEEDS_USER_NOTIFICATION_TYPES.has(notificationType)) ||
		toolName === "AskUser"
	) {
		return "needs_user";
	}
	if (
		hookEventName ? TURN_END_HOOK_EVENTS.has(hookEventName) : SOURCES_WITHOUT_TURN_END_EVENT_NAME.has(source ?? "")
	) {
		return "turn_end";
	}
	return "other";
}

// xterm sends focus events, cursor/device reports, OSC replies and mouse reports (clicks, wheel
// scrolling while the agent's TUI tracks the mouse) on the same socket as keystrokes. None of them is typing.
const TERMINAL_REPORT_PATTERN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences
	/^(?:\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

export function isTerminalReport(data: Buffer): boolean {
	return TERMINAL_REPORT_PATTERN.test(data.toString("latin1"));
}
