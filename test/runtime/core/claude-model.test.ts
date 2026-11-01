import { describe, expect, it } from "vitest";
import {
	type RuntimeBoardCard,
	type RuntimeConfigResponse,
	type RuntimeConfigSaveRequest,
	type RuntimeTaskSessionSummary,
	runtimeBoardCardSchema,
	runtimeConfigResponseSchema,
	runtimeConfigSaveRequestSchema,
	runtimeTaskSessionSummarySchema,
} from "../../../src/core/api-contract";
import {
	DEFAULT_CLAUDE_MODEL,
	isRuntimeClaudeModel,
	readCliModelOption,
	resolveEffectiveClaudeModel,
	runtimeClaudeModelSchema,
} from "../../../src/core/claude-model";

describe("runtime claude model helpers", () => {
	it("resolves the effective claude model from the card, the default, or the fallback", () => {
		expect(resolveEffectiveClaudeModel("haiku", "opus")).toBe("haiku");
		expect(resolveEffectiveClaudeModel("sonnet", "opus")).toBe("sonnet");
		expect(resolveEffectiveClaudeModel(undefined, "sonnet")).toBe("sonnet");
		expect(resolveEffectiveClaudeModel(undefined, undefined)).toBe("opus");
		expect(DEFAULT_CLAUDE_MODEL).toBe("opus");
	});

	it("reads the claude --model CLI option", () => {
		expect(readCliModelOption(["--model", "sonnet"])).toBe("sonnet");
		expect(readCliModelOption(["--model=haiku"])).toBe("haiku");
		expect(readCliModelOption(["--model", "custom-x"])).toBe("custom-x");
		expect(readCliModelOption(["--permission-mode", "auto"])).toBeNull();
		expect(readCliModelOption([])).toBeNull();
		expect(readCliModelOption(["--model"])).toBeNull();
	});

	it("recognizes the runtime claude model aliases", () => {
		expect(isRuntimeClaudeModel("haiku")).toBe(true);
		expect(isRuntimeClaudeModel("sonnet")).toBe(true);
		expect(isRuntimeClaudeModel("opus")).toBe(true);
		expect(isRuntimeClaudeModel("custom-x")).toBe(false);
		expect(isRuntimeClaudeModel(undefined)).toBe(false);
	});

	it("accepts only the haiku, sonnet and opus aliases", () => {
		expect(runtimeClaudeModelSchema.safeParse("haiku").success).toBe(true);
		expect(runtimeClaudeModelSchema.safeParse("sonnet").success).toBe(true);
		expect(runtimeClaudeModelSchema.safeParse("opus").success).toBe(true);
		expect(runtimeClaudeModelSchema.safeParse("custom-x").success).toBe(false);
	});
});

describe("claude task session model schemas", () => {
	it("parses a legacy task card without claudeModel", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Do the thing",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
		}) satisfies RuntimeBoardCard;
		expect(card.claudeModel).toBeUndefined();
	});

	it("parses a task card with a claudeModel", () => {
		const card = runtimeBoardCardSchema.parse({
			id: "task-1",
			prompt: "Do the thing",
			startInPlanMode: false,
			baseRef: "main",
			createdAt: 1,
			updatedAt: 2,
			claudeModel: "haiku",
		}) satisfies RuntimeBoardCard;
		expect(card.claudeModel).toBe("haiku");
	});

	it("parses a task session summary without claudeModel and with it", () => {
		const summaryWithoutModel = runtimeTaskSessionSummarySchema.parse({
			taskId: "task-1",
			state: "running",
			agentId: "claude",
			workspacePath: "/tmp/worktree",
			pid: 1,
			startedAt: 1,
			updatedAt: 2,
			lastOutputAt: 2,
			reviewReason: null,
			exitCode: null,
		}) satisfies RuntimeTaskSessionSummary;
		expect(summaryWithoutModel.claudeModel).toBeUndefined();

		const summaryWithModel = runtimeTaskSessionSummarySchema.parse({
			taskId: "task-1",
			state: "running",
			agentId: "claude",
			claudeModel: "haiku",
			workspacePath: "/tmp/worktree",
			pid: 1,
			startedAt: 1,
			updatedAt: 2,
			lastOutputAt: 2,
			reviewReason: null,
			exitCode: null,
		}) satisfies RuntimeTaskSessionSummary;
		expect(summaryWithModel.claudeModel).toBe("haiku");
	});

	it("parses a legacy runtime config response without claudeDefaultModel and resolves the default", () => {
		const config = runtimeConfigResponseSchema.parse({
			selectedAgentId: "claude",
			selectedShortcutLabel: null,
			agentAutonomousModeEnabled: true,
			debugModeEnabled: false,
			effectiveCommand: "claude",
			globalConfigPath: "/tmp/global-config.json",
			projectConfigPath: null,
			readyForReviewNotificationsEnabled: true,
			detectedCommands: ["claude"],
			agents: [],
			shortcuts: [],
			clineProviderSettings: {
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: false,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			},
			commitPromptTemplate: "",
			openPrPromptTemplate: "",
			commitPromptTemplateDefault: "",
			openPrPromptTemplateDefault: "",
		}) satisfies RuntimeConfigResponse;
		expect(config.claudeDefaultModel).toBe("opus");
		expect(resolveEffectiveClaudeModel(undefined, config.claudeDefaultModel)).toBe("opus");
	});

	it("parses a runtime config response with a claudeDefaultModel", () => {
		const config = runtimeConfigResponseSchema.parse({
			selectedAgentId: "claude",
			selectedShortcutLabel: null,
			agentAutonomousModeEnabled: true,
			debugModeEnabled: false,
			effectiveCommand: "claude",
			globalConfigPath: "/tmp/global-config.json",
			projectConfigPath: null,
			readyForReviewNotificationsEnabled: true,
			detectedCommands: ["claude"],
			agents: [],
			shortcuts: [],
			clineProviderSettings: {
				providerId: null,
				modelId: null,
				baseUrl: null,
				apiKeyConfigured: false,
				oauthProvider: null,
				oauthAccessTokenConfigured: false,
				oauthRefreshTokenConfigured: false,
				oauthAccountId: null,
				oauthExpiresAt: null,
			},
			commitPromptTemplate: "",
			openPrPromptTemplate: "",
			commitPromptTemplateDefault: "",
			openPrPromptTemplateDefault: "",
			claudeDefaultModel: "sonnet",
		}) satisfies RuntimeConfigResponse;
		expect(config.claudeDefaultModel).toBe("sonnet");
	});

	it("parses a legacy runtime config save request without claudeDefaultModel and with it", () => {
		const saveRequest = runtimeConfigSaveRequestSchema.parse({
			selectedAgentId: "claude",
		}) satisfies RuntimeConfigSaveRequest;
		expect(saveRequest.claudeDefaultModel).toBeUndefined();

		const savedRequest = runtimeConfigSaveRequestSchema.parse({
			selectedAgentId: "claude",
			claudeDefaultModel: "haiku",
		}) satisfies RuntimeConfigSaveRequest;
		expect(savedRequest.claudeDefaultModel).toBe("haiku");
	});
});
