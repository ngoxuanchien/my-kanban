import { describe, expect, it } from "vitest";

import { RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS } from "../../src/core/agent-catalog";
import {
	renderAppendSystemPrompt,
	resolveAppendSystemPromptCommandPrefix,
	resolveHomeAgentAppendSystemPrompt,
} from "../../src/prompts/append-system-prompt";

describe("resolveAppendSystemPromptCommandPrefix", () => {
	it("returns npx prefix for npx transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/Users/example/.npm/_npx/593b71878a7c70f2/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("npx -y kanban");
	});

	it("returns bun x prefix for bun x transient installs", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			argv: ["node", "/private/tmp/bunx-501-kanban@1.0.0/node_modules/kanban/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("bun x kanban");
	});

	it("falls back to the current runnable invocation for local entrypoints", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js'");
	});

	it("falls back to the current runnable invocation when realpath resolution fails", () => {
		const prefix = resolveAppendSystemPromptCommandPrefix({
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/tmp/missing-kanban-cli.js"],
			resolveRealPath: () => {
				throw new Error("missing");
			},
		});
		expect(prefix).toBe("'/usr/local/bin/node' '/tmp/missing-kanban-cli.js'");
	});
});

describe("renderAppendSystemPrompt", () => {
	it("documents agent selection and review for task creation and updates", () => {
		const rendered = renderAppendSystemPrompt("kanban");
		const agentIds = RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS.join(" | ");
		const createSection = rendered.slice(rendered.indexOf("## task create"), rendered.indexOf("## task update"));
		const updateSection = rendered.slice(rendered.indexOf("## task update"), rendered.indexOf("## task done"));

		for (const [section, agentIdParameter] of [
			[createSection, `--agent-id <${agentIds}>`],
			[updateSection, `--agent-id <${agentIds}|default>`],
		] as const) {
			const commandLine = section.split("Command:\n")[1]?.split("\n")[0] ?? "";
			expect(commandLine).toContain("--agent-id");
			expect(commandLine).toContain("--agent-review-enabled");
			expect(section).toContain(`- \`${agentIdParameter}\``);
			expect(section).toContain("- `--agent-review-enabled <true|false>`");
			expect(section).toContain("When true, the sidebar agent reviews the task when it reaches Review");
		}
		expect(updateSection).toContain("Use `default` to clear the override.");
	});

	it("renders Kanban sidebar guidance and command reference", () => {
		const rendered = renderAppendSystemPrompt("kanban");
		expect(rendered).toContain("Kanban sidebar agent");
		expect(rendered).toContain("kanban task create");
		expect(rendered).toContain("kanban task done");
		expect(rendered).toContain("kanban task delete");
		expect(rendered).toContain("[Kanban review]");
		expect(rendered).toContain("task send");
		expect(rendered).toContain("task handoff");
		expect(rendered).toContain("task review-failed --task-id <task_id>");
		expect(rendered).toContain("task done --task-id <task_id> --review-passed");
		expect(rendered).toContain(
			'3. If it fails on a round below the cap and the round is not a multiple of 3, use `task send --task-id <task_id> --message "<concrete fix list with file:line and failing command output>"`. Report what you sent, identifying the task by title and id, in one chat line.',
		);
		expect(rendered).toContain("identify it by its title followed by its id in parentheses");
		expect(rendered).toContain(
			"If handoff returns an error, run `task review-failed --task-id <task_id>`, leave the task in Review",
		);
		expect(rendered).toContain(
			'If it fails on a round equal to the cap and `handOffCount` from `task list` is less than 2, run `task handoff --task-id <task_id> --message "<the same concrete fix list>"`',
		);
		expect(rendered).toContain(
			"If it fails on a round equal to the cap and `handOffCount` from `task list` is 2, run `task review-failed --task-id <task_id>`, do not send or hand off, leave it in Review",
		);
		expect(rendered).toContain("The cap is 3 × (handOffCount + 1), using `handOffCount` from `task list`");
		expect(rendered).not.toContain("below the cap that is a multiple of 3");
		expect(rendered).toContain(
			"After a pass, only if the round was above 1 or `handOffCount` from `task list` is above 0",
		);
		expect(rendered).toContain("matching existing topic file in the Basic Memory project `my-kanban`");
		expect(rendered).not.toContain("3/3 or 6/6");
		expect(rendered).not.toContain("9/9");
		expect(rendered).toContain("--column backlog|in_progress|review|done");
		expect(rendered).toContain("Provide exactly one of");
		expect(rendered).toContain("task delete --column done");
		expect(rendered).toContain("kanban task link");
		expect(rendered).toContain("If a task command fails because the runtime is unavailable");
		expect(rendered).toContain("If the user asks for GitHub work");
		expect(rendered).toContain("gh issue view");
		expect(rendered).toContain("If the user references Linear");
		expect(rendered).toContain("Current home agent: `unknown`");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
	});

	it("renders only the active-agent Linear MCP guidance when an agent is provided", () => {
		const rendered = renderAppendSystemPrompt("kanban", {
			agentId: "codex",
		});

		expect(rendered).toContain("Current home agent: `codex`");
		expect(rendered).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
		expect(rendered).not.toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});
});

describe("resolveHomeAgentAppendSystemPrompt", () => {
	it("returns null for non-home task sessions", () => {
		expect(resolveHomeAgentAppendSystemPrompt("task-1")).toBeNull();
	});

	it("returns the appended prompt for current home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:codex", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Kanban sidebar agent");
		expect(prompt).toContain("'/usr/local/bin/node' '/Users/example/repo/dist/cli.js' task list");
		expect(prompt).toContain("Current home agent: `codex`");
		expect(prompt).toContain("codex mcp add linear --url https://mcp.linear.app/mcp");
		expect(prompt).not.toContain("claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp");
	});

	it("returns active-agent guidance for droid home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:droid", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `droid`");
		expect(prompt).toContain("droid mcp add linear https://mcp.linear.app/mcp --type http");
	});

	it("returns active-agent guidance for kiro home sidebar sessions", () => {
		const prompt = resolveHomeAgentAppendSystemPrompt("__home_agent__:workspace-1:kiro", {
			currentVersion: "0.1.10",
			cwd: "/Users/example/repo",
			execPath: "/usr/local/bin/node",
			execArgv: [],
			argv: ["node", "/Users/example/repo/dist/cli.js"],
			resolveRealPath: (path) => path,
		});
		expect(prompt).toContain("Current home agent: `kiro`");
		expect(prompt).toContain("kiro-cli mcp add --name linear --url https://mcp.linear.app/mcp --scope global");
		expect(prompt).not.toContain("--scope user");
	});
});
