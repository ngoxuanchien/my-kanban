// Turns `claude -p --output-format stream-json --verbose` output into readable terminal lines
// for the reviewer log, and keeps the text the verdict is parsed from.
import { z } from "zod";

const TOOL_RESULT_MAX_LINES = 20;
const TOOL_INPUT_MAX_CHARS = 300;

const textContentSchema = z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]);

const contentBlockSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("thinking"), thinking: z.string() }),
	z.object({ type: z.literal("tool_use"), name: z.string(), input: z.record(z.string(), z.unknown()) }),
	z.object({
		type: z.literal("tool_result"),
		content: textContentSchema.optional(),
		is_error: z.boolean().optional(),
	}),
]);

const streamEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("system"), subtype: z.string().optional(), model: z.string().optional() }),
	z.object({ type: z.literal("assistant"), message: z.object({ content: z.array(z.unknown()) }) }),
	z.object({ type: z.literal("user"), message: z.object({ content: z.union([z.string(), z.array(z.unknown())]) }) }),
	z.object({
		type: z.literal("result"),
		subtype: z.string().optional(),
		result: z.string().optional(),
		num_turns: z.number().optional(),
		duration_ms: z.number().optional(),
	}),
]);

type ContentBlock = z.infer<typeof contentBlockSchema>;

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
	const value = input[key];
	return typeof value === "string" ? value : null;
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
	const command = stringInput(input, "command");
	if (name === "Bash" && command !== null) {
		return `$ ${command}`;
	}
	const target =
		stringInput(input, "file_path") ??
		[stringInput(input, "pattern"), stringInput(input, "path")].filter(Boolean).join(" in ");
	return `→ ${name} ${target || truncate(JSON.stringify(input), TOOL_INPUT_MAX_CHARS)}`;
}

function formatToolResult(content: z.infer<typeof textContentSchema> | undefined, isError: boolean): string {
	const text =
		typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n");
	const lines = text.replace(/\n+$/, "").split("\n");
	const shown = lines.slice(0, TOOL_RESULT_MAX_LINES).map((line) => `  ${line}`);
	if (lines.length > TOOL_RESULT_MAX_LINES) {
		shown.push(`  … ${lines.length - TOOL_RESULT_MAX_LINES} more lines`);
	}
	return `${isError ? "  ✗ error\n" : ""}${shown.join("\n")}`;
}

function formatBlock(block: ContentBlock): string | null {
	switch (block.type) {
		case "text":
			return block.text.trim() ? block.text.trim() : null;
		case "thinking":
			// Redacted thinking arrives as an empty string with only a signature.
			return block.thinking.trim() ? `✻ ${block.thinking.trim()}` : null;
		case "tool_use":
			return formatToolUse(block.name, block.input);
		case "tool_result":
			return formatToolResult(block.content, block.is_error === true);
	}
}

function parseBlocks(content: unknown[]): ContentBlock[] {
	return content.flatMap((raw) => {
		const parsed = contentBlockSchema.safeParse(raw);
		return parsed.success ? [parsed.data] : [];
	});
}

export interface ClaudeStreamParser {
	/** Feeds raw stdout; returns readable text for the complete lines in it. */
	push(chunk: string): string;
	/** Flushes a trailing partial line; returns its readable text and the text to parse the verdict from. */
	finish(): { display: string; output: string };
}

export function createClaudeStreamParser(): ClaudeStreamParser {
	let pending = "";
	let resultText: string | null = null;
	// Fallback for a stream cut off before its result event.
	const assistantTexts: string[] = [];

	const formatLine = (line: string): string | null => {
		if (!line.trim()) {
			return null;
		}
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			return line;
		}
		const parsed = streamEventSchema.safeParse(json);
		if (!parsed.success) {
			return null; // rate limit and other events we do not show
		}
		const event = parsed.data;
		switch (event.type) {
			case "system":
				return event.subtype === "init"
					? `● Reviewer session started${event.model ? ` (${event.model})` : ""}`
					: null;
			case "assistant":
			case "user": {
				if (typeof event.message.content === "string") {
					return null; // the prompt itself
				}
				const blocks = parseBlocks(event.message.content);
				if (event.type === "assistant") {
					assistantTexts.push(...blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])));
				}
				const lines = blocks.map(formatBlock).filter((text): text is string => text !== null);
				return lines.length > 0 ? lines.join("\n") : null;
			}
			case "result": {
				resultText = event.result ?? null;
				const details = [
					event.subtype,
					event.num_turns === undefined ? null : `${event.num_turns} turns`,
					event.duration_ms === undefined ? null : `${Math.round(event.duration_ms / 1000)}s`,
				].filter(Boolean);
				return `● Reviewer finished (${details.join(", ")})`;
			}
		}
	};

	const formatLines = (lines: string[]): string =>
		lines
			.map(formatLine)
			.filter((text): text is string => text !== null)
			.map((text) => `${text}\n`)
			.join("");

	return {
		push(chunk) {
			const lines = (pending + chunk).split("\n");
			pending = lines.pop() ?? "";
			return formatLines(lines);
		},
		finish() {
			const display = formatLines([pending]);
			pending = "";
			return { display, output: resultText ?? assistantTexts.join("\n") };
		},
	};
}
