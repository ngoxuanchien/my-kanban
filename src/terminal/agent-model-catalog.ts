// Reads the model lists an agent CLI reports, so Kanban can validate and offer per-task models.
// Commands run with execFile (no shell) and never write to the agents' own config.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { RuntimeAgentModelCatalog, RuntimeAgentModelCatalogEntry } from "../core/api-contract";
import { runtimeClaudeModelSchema } from "../core/claude-model";

export type AgentModelCatalogEntry = RuntimeAgentModelCatalogEntry;
export type AgentModelCatalog = RuntimeAgentModelCatalog;
export type AgentModelCatalogAgentId = "codex" | "opencode" | "claude";

const execFileAsync = promisify(execFile);
const CATALOG_COMMAND_TIMEOUT_MS = 30_000;
// `codex debug models` includes each model's full base instructions (hundreds of KiB).
const CATALOG_COMMAND_MAX_BUFFER = 64 * 1024 * 1024;

const codexModelCatalogSchema = z.object({
	models: z.array(
		z.object({
			slug: z.string(),
			display_name: z.string().nullish(),
			description: z.string().nullish(),
			visibility: z.string().nullish(),
			default_reasoning_level: z.string().nullish(),
			supported_reasoning_levels: z.array(z.object({ effort: z.string() })).nullish(),
		}),
	),
});

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parseCodexModelCatalog(json: string): AgentModelCatalog {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (error) {
		return { ok: false, error: `codex debug models printed invalid JSON: ${errorMessage(error)}` };
	}
	const parsed = codexModelCatalogSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: `codex debug models printed an unexpected shape: ${parsed.error.message}` };
	}
	return {
		ok: true,
		models: parsed.data.models
			.filter((model) => model.visibility === "list")
			.map((model) => ({
				id: model.slug,
				displayName: model.display_name ?? undefined,
				description: model.description ?? undefined,
				efforts: (model.supported_reasoning_levels ?? []).map((level) => level.effort),
				defaultEffort: model.default_reasoning_level ?? undefined,
			})),
	};
}

export function parseOpenCodeModelCatalog(text: string): AgentModelCatalog {
	const ids = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (ids.length === 0) {
		return { ok: false, error: "opencode models printed no models." };
	}
	return { ok: true, models: ids.map((id) => ({ id, efforts: [] })) };
}

async function readCatalog(agentId: AgentModelCatalogAgentId): Promise<AgentModelCatalog> {
	if (agentId === "claude") {
		return { ok: true, models: runtimeClaudeModelSchema.options.map((id) => ({ id, efforts: [] })) };
	}
	const [command, args, parse] =
		agentId === "codex"
			? (["codex", ["debug", "models"], parseCodexModelCatalog] as const)
			: (["opencode", ["models"], parseOpenCodeModelCatalog] as const);
	try {
		const { stdout } = await execFileAsync(command, [...args], {
			encoding: "utf8",
			timeout: CATALOG_COMMAND_TIMEOUT_MS,
			maxBuffer: CATALOG_COMMAND_MAX_BUFFER,
		});
		return parse(stdout);
	} catch (error) {
		return { ok: false, error: `${command} ${args.join(" ")} failed: ${errorMessage(error)}` };
	}
}

// Cached for the runtime's lifetime (failures too); `refresh` re-reads.
const catalogCache = new Map<AgentModelCatalogAgentId, Promise<AgentModelCatalog>>();

export async function loadAgentModelCatalog(
	agentId: AgentModelCatalogAgentId,
	options?: { refresh?: boolean },
): Promise<AgentModelCatalog> {
	let cached = options?.refresh ? undefined : catalogCache.get(agentId);
	if (!cached) {
		cached = readCatalog(agentId);
		catalogCache.set(agentId, cached);
	}
	return await cached;
}
