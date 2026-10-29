import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface AgentTranscriptTurn {
	role: "user" | "assistant" | "tool";
	text: string;
	at?: number;
}

export interface AgentTranscriptResult {
	turns: AgentTranscriptTurn[];
	truncated: boolean;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : null;
}

function text(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((part) => {
				const item = record(part);
				return typeof item?.text === "string" ? item.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return null;
}

function timestamp(value: unknown): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function parseLine(agentId: string, value: RecordValue): AgentTranscriptTurn[] {
	if (agentId === "codex") {
		const payload = record(value.payload);
		if (value.type !== "response_item" || !payload) return [];
		if (payload.type === "function_call" || payload.type === "function_call_output") {
			const args = typeof payload.arguments === "string" ? payload.arguments.replaceAll(/\s+/gu, " ") : "";
			return [
				{ role: "tool", text: `${String(payload.name ?? "tool")} ${args}`.trim(), at: timestamp(value.timestamp) },
			];
		}
		if (payload.type !== "message") return [];
		const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
		const content = text(payload.content);
		return role && content ? [{ role, text: content, at: timestamp(value.timestamp) }] : [];
	}
	if (agentId === "claude") {
		if (value.type !== "user" && value.type !== "assistant") return [];
		const message = record(value.message);
		if (!Array.isArray(message?.content)) {
			const content = text(message?.content);
			return content ? [{ role: value.type, text: content, at: timestamp(value.timestamp) }] : [];
		}
		return message.content.flatMap<AgentTranscriptTurn>((part) => {
			const item = record(part);
			if (item?.type === "tool_use" || item?.type === "tool_result") {
				const detail = item.type === "tool_use" ? item.input : item.content;
				return [
					{
						role: "tool" as const,
						text: `${String(item.name ?? "tool")} ${JSON.stringify(detail ?? "")}`,
						at: timestamp(value.timestamp),
					},
				];
			}
			return typeof item?.text === "string"
				? [{ role: value.type as "user" | "assistant", text: item.text, at: timestamp(value.timestamp) }]
				: [];
		});
	}
	if (agentId === "antigravity" || agentId === "gemini") {
		if (value.type === "USER_INPUT") {
			const content = text(value.content);
			return content ? [{ role: "user", text: content, at: timestamp(value.created_at) }] : [];
		}
		if (value.type === "PLANNER_RESPONSE") {
			const content = text(value.content);
			const turns: AgentTranscriptTurn[] = content
				? [{ role: "assistant", text: content, at: timestamp(value.created_at) }]
				: [];
			for (const call of Array.isArray(value.tool_calls) ? value.tool_calls : []) {
				const item = record(call);
				if (item)
					turns.push({ role: "tool", text: `${String(item.name ?? "tool")} ${JSON.stringify(item.args ?? {})}` });
			}
			return turns;
		}
		return [];
	}
	if (agentId === "opencode") {
		if (value.type !== "message") return [];
		const message = record(value.message) ?? value;
		const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : null;
		const content = text(message.content);
		return role && content ? [{ role, text: content, at: timestamp(value.timestamp ?? message.createdAt) }] : [];
	}
	return [];
}

async function allowedTranscriptPath(path: string): Promise<string | null> {
	if (!isAbsolute(path)) return null;
	try {
		const actualPath = await realpath(path);
		const homes = await Promise.all([
			realpath(resolve(homedir(), ".codex")).catch(() => resolve(homedir(), ".codex")),
			realpath(resolve(homedir(), ".gemini", "antigravity-cli")).catch(() =>
				resolve(homedir(), ".gemini", "antigravity-cli"),
			),
			realpath(resolve(homedir(), ".local", "share", "opencode")).catch(() =>
				resolve(homedir(), ".local", "share", "opencode"),
			),
			realpath(resolve(homedir(), ".claude")).catch(() => resolve(homedir(), ".claude")),
		]);
		return homes.some((home) => {
			const pathFromHome = relative(home, actualPath);
			return pathFromHome === "" || (!pathFromHome.startsWith("..") && !isAbsolute(pathFromHome));
		})
			? actualPath
			: null;
	} catch {
		return null;
	}
}

export async function readAgentTranscript(
	agentId: string,
	path: string,
	before?: number,
): Promise<AgentTranscriptResult | { unavailable: string }> {
	const allowedPath = await allowedTranscriptPath(path);
	if (!allowedPath) return { unavailable: "path not allowed" };
	let contents: string;
	try {
		contents = await readFile(allowedPath, "utf8");
	} catch {
		return { unavailable: "file not found" };
	}
	const turns = contents
		.split(/\r?\n/u)
		.flatMap((line) => {
			try {
				const parsed = record(JSON.parse(line));
				return parsed ? parseLine(agentId, parsed) : [];
			} catch {
				return [];
			}
		})
		.filter((turn) => before === undefined || turn.at === undefined || turn.at < before);
	return { turns: turns.slice(-500), truncated: turns.length > 500 };
}
