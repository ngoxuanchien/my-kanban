import { describe, expect, it } from "vitest";

import { classifyTurnEnd, isTerminalReport } from "../../../src/agent-review/task-session-signals";
import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "../../../src/core/api-contract";

function createSummary(overrides: Partial<RuntimeTaskSessionSummary> = {}): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "claude",
		workspacePath: "/tmp/worktree",
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "hook",
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		...overrides,
	};
}

function hookSummary(activity: Partial<RuntimeTaskHookActivity>): RuntimeTaskSessionSummary {
	return createSummary({
		latestHookActivity: {
			activityText: null,
			toolName: null,
			toolInputSummary: null,
			finalMessage: null,
			hookEventName: null,
			notificationType: null,
			source: null,
			...activity,
		},
	});
}

describe("classifyTurnEnd", () => {
	it.each([
		["claude Stop", { source: "claude", hookEventName: "Stop" }],
		["droid Stop", { source: "droid", hookEventName: "Stop" }],
		["kiro stop", { source: "kiro", hookEventName: "stop" }],
		["cline TaskComplete", { source: "cline", hookEventName: "TaskComplete" }],
		["claude SubagentStop", { source: "claude", hookEventName: "SubagentStop" }],
		["gemini AfterAgent", { source: "gemini", hookEventName: "AfterAgent" }],
		["codex task_complete", { source: "codex", hookEventName: "task_complete" }],
		["codex final agent_message", { source: "codex", hookEventName: "agent_message" }],
		["codex without event name", { source: "codex", hookEventName: null }],
		["opencode session.idle", { source: "opencode", hookEventName: "session.idle" }],
		["opencode session.status", { source: "opencode", hookEventName: "session.status" }],
		["opencode without event name", { source: "opencode", hookEventName: null }],
		["cline sdk agent_end", { source: "cline-sdk", hookEventName: "agent_end" }],
	])("treats %s as turn_end", (_label, activity) => {
		expect(classifyTurnEnd(hookSummary(activity))).toBe("turn_end");
	});

	it.each([
		["claude PermissionRequest", { source: "claude", hookEventName: "PermissionRequest" }],
		[
			"claude permission Notification",
			{ source: "claude", hookEventName: "Notification", notificationType: "permission_prompt" },
		],
		["cline user_attention", { source: "cline", notificationType: "user_attention" }],
		[
			"opencode permission",
			{ source: "opencode", hookEventName: "PermissionRequest", notificationType: "permission.asked" },
		],
		["codex approval request", { source: "codex", hookEventName: "exec_approval_request" }],
		["droid AskUser", { source: "droid", hookEventName: "PreToolUse", toolName: "AskUser" }],
	])("treats %s as needs_user", (_label, activity) => {
		expect(classifyTurnEnd(hookSummary(activity))).toBe("needs_user");
	});

	it("treats attention as needs_user", () => {
		expect(classifyTurnEnd(createSummary({ reviewReason: "attention" }))).toBe("needs_user");
	});

	it("treats a clean exit as turn_end and a failed exit as other", () => {
		expect(classifyTurnEnd(createSummary({ reviewReason: "exit", exitCode: 0 }))).toBe("turn_end");
		expect(classifyTurnEnd(createSummary({ reviewReason: "exit", exitCode: 1 }))).toBe("other");
	});

	it("treats interrupted, error, running and unknown hooks as other", () => {
		expect(classifyTurnEnd(createSummary({ state: "interrupted", reviewReason: "interrupted" }))).toBe("other");
		expect(classifyTurnEnd(createSummary({ reviewReason: "error" }))).toBe("other");
		expect(classifyTurnEnd({ ...hookSummary({ hookEventName: "Stop" }), state: "running" })).toBe("other");
		expect(classifyTurnEnd(hookSummary({ source: "claude", hookEventName: "PreToolUse" }))).toBe("other");
		expect(classifyTurnEnd(hookSummary({ source: "claude", hookEventName: null }))).toBe("other");
		expect(classifyTurnEnd(createSummary({ latestHookActivity: null }))).toBe("other");
	});
});

describe("isTerminalReport", () => {
	it.each([
		["focus in", "\x1b[I", true],
		["focus out", "\x1b[O", true],
		["cursor position report", "\x1b[12;5R", true],
		["primary device attributes", "\x1b[?1;2c", true],
		["secondary device attributes", "\x1b[>0;276;0c", true],
		["OSC color reply with BEL", "\x1b]11;rgb:1f1f/2424/2828\x07", true],
		["OSC color reply with ST", "\x1b]10;rgb:e6e6/eded/f3f3\x1b\\", true],
		["several replies", "\x1b[I\x1b[12;5R", true],
		["SGR mouse wheel", "\x1b[<65;40;12M\x1b[<65;40;12M", true],
		["SGR mouse release", "\x1b[<0;3;4m", true],
		["X10 mouse click", "\x1b[M #!", true],
		["arrow key", "\x1b[A", false],
		["plain key", "a", false],
		["reply followed by a key", "\x1b[Ia", false],
		["enter", "\r", false],
		["arrow key", "\x1b[A", false],
		["empty", "", false],
	])("%s", (_label, data, expected) => {
		expect(isTerminalReport(Buffer.from(data, "utf8"))).toBe(expected);
	});
});
