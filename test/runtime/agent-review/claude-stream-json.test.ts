import { describe, expect, it } from "vitest";

import { createClaudeStreamParser } from "../../../src/agent-review/claude-stream-json";
import { parseReviewerOutput } from "../../../src/agent-review/reviewer-output";

const verdictBlock = `<<<KANBAN_AGENT_REVIEW_RESULT
{"verdict":"fail","appVerified":true,"appCheck":"ran it","tests":[],"summary":null,"fixPrompt":"Fix the test","notes":null}
KANBAN_AGENT_REVIEW_RESULT>>>`;

const events = [
	{ type: "system", subtype: "hook_started", hook_name: "SessionStart" },
	{ type: "system", subtype: "init", model: "claude-opus-5-5" },
	{ type: "user", message: { role: "user", content: "the review prompt" } },
	{ type: "assistant", message: { content: [{ type: "thinking", thinking: "", signature: "abc" }] } },
	{ type: "assistant", message: { content: [{ type: "text", text: "Checking the diff." }] } },
	{
		type: "assistant",
		message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git status" } }] },
	},
	{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "clean\n" }] } },
	{
		type: "assistant",
		message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/repo/a.ts" } }] },
	},
	{
		type: "user",
		message: {
			content: [
				{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "boom" }], is_error: true },
			],
		},
	},
	{ type: "rate_limit_event", rate_limit_info: {} },
	{ type: "assistant", message: { content: [{ type: "text", text: verdictBlock }] } },
	{ type: "result", subtype: "success", result: verdictBlock, num_turns: 3, duration_ms: 12_400 },
];

const stream = events.map((event) => JSON.stringify(event)).join("\n");

describe("createClaudeStreamParser", () => {
	it("renders events as readable lines and returns the result text", () => {
		const parser = createClaudeStreamParser();
		const display = parser.push(`${stream}\n`);
		const finished = parser.finish();

		expect(display).toBe(
			[
				"● Reviewer session started (claude-opus-5-5)",
				"Checking the diff.",
				"$ git status",
				"  clean",
				"→ Read /repo/a.ts",
				"  ✗ error\n  boom",
				verdictBlock,
				"● Reviewer finished (success, 3 turns, 12s)",
				"",
			].join("\n"),
		);
		expect(finished).toEqual({ display: "", output: verdictBlock });
		expect(parseReviewerOutput(finished.output)).toMatchObject({ ok: true, result: { verdict: "fail" } });
	});

	it("handles events split across chunks", () => {
		const parser = createClaudeStreamParser();
		let display = "";
		for (let index = 0; index < stream.length; index += 7) {
			display += parser.push(stream.slice(index, index + 7));
		}
		// The last event has no trailing newline until finish.
		expect(display).not.toContain("Reviewer finished");
		const finished = parser.finish();
		expect(finished.display).toBe("● Reviewer finished (success, 3 turns, 12s)\n");
		expect(finished.output).toBe(verdictBlock);
	});

	it("falls back to assistant text when the stream is cut off before the result event", () => {
		const parser = createClaudeStreamParser();
		const cutOff = events
			.slice(0, -1)
			.map((event) => JSON.stringify(event))
			.join("\n");
		parser.push(`${cutOff}\n{"type":"result","subtyp`);
		const finished = parser.finish();
		expect(finished.display).toBe('{"type":"result","subtyp\n');
		expect(parseReviewerOutput(finished.output)).toMatchObject({ ok: true, result: { verdict: "fail" } });
	});

	it("shows non-JSON lines as they are and yields no verdict for an invalid stream", () => {
		const parser = createClaudeStreamParser();
		expect(parser.push("Error: not logged in\n{not json}\n")).toBe("Error: not logged in\n{not json}\n");
		const finished = parser.finish();
		expect(finished.output).toBe("");
		expect(parseReviewerOutput(finished.output)).toEqual({ ok: false, error: "no result block found" });
	});

	it("caps long tool results", () => {
		const parser = createClaudeStreamParser();
		const content = Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n");
		const display = parser.push(
			`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content }] } })}\n`,
		);
		expect(display).toContain("  line 19\n  … 5 more lines\n");
		expect(display).not.toContain("line 20");
	});
});
