import type { DeclaredEmployee } from "../state/employees";
import { listInstalledSkillNames, resolveSkillSources, type SkillSource } from "../state/reference-skills";
import { resolveScoreAgentKey } from "./claude-model";

export interface EffectiveSkillSet {
	skills: SkillSource[];
	/** Server names to keep on. `null` = usage unknown, leave every MCP server on. */
	mcpEnabled: string[] | null;
}

/** Keys whose declared extras apply: the plain agent (`codex`) and the model key (`codex:gpt-6-luna`). */
function employeeKeys(agentId: string, model: string | null): string[] {
	const modelKey = resolveScoreAgentKey({ agentId, sessionAgentModel: model });
	return modelKey === agentId ? [agentId] : [agentId, modelKey];
}

function expandGlobs(patterns: string[], installed: string[]): string[] {
	const names: string[] = [];
	for (const pattern of patterns) {
		if (pattern.endsWith("*")) {
			const prefix = pattern.slice(0, -1);
			names.push(...installed.filter((name) => name.startsWith(prefix)));
		} else {
			names.push(pattern);
		}
	}
	return names;
}

export async function resolveEffectiveSkillSet(input: {
	agentId: string;
	model: string | null;
	declared: Record<string, DeclaredEmployee>;
	reference: string[];
	mcpUsage: Map<string, number> | null;
	home: string;
}): Promise<EffectiveSkillSet> {
	const declared = employeeKeys(input.agentId, input.model).map((key) => input.declared[key]);
	const extraSkills = declared.flatMap((employee) => employee?.skills ?? []);
	const installed = extraSkills.some((name) => name.endsWith("*")) ? await listInstalledSkillNames(input.home) : [];
	const names = [...new Set([...input.reference, ...expandGlobs(extraSkills, installed)])];
	// Two plugins can ship the same skill name; they would share one worktree folder, so keep the first.
	const sources = new Map<string, SkillSource>();
	for (const source of await resolveSkillSources(input.home, names)) {
		if (!sources.has(source.name)) sources.set(source.name, source);
	}
	const mcpEnabled = input.mcpUsage
		? [
				...new Set([
					...[...input.mcpUsage].filter(([, calls]) => calls > 0).map(([server]) => server),
					...declared.flatMap((employee) => employee?.mcp ?? []),
				]),
			]
		: null;
	return { skills: [...sources.values()], mcpEnabled };
}
