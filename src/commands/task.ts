import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import type { Command } from "commander";
import { isRuntimeAgentLaunchSupported, RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS } from "../core/agent-catalog";
import {
	type DifficultyModelCell,
	type DifficultyModelMap,
	runtimeTaskDifficultySchema,
	type TaskDifficulty,
} from "../core/agent-model";
import type {
	RuntimeAgentId,
	RuntimeAgentModelCatalogsResponse,
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardDependency,
	RuntimeClineReasoningEffort,
	RuntimeTaskClineSettings,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	runtimeAddTaskIssueReviewRequestSchema,
	runtimeAgentIdSchema,
	runtimeClineReasoningEffortSchema,
} from "../core/api-contract";
import {
	isRuntimeClaudeModel,
	type RuntimeClaudeModel,
	resolveScoreAgentKey,
	runtimeClaudeModelSchema,
} from "../core/claude-model";
import { resolveEffectiveTaskAgentId } from "../core/effective-task-agent";
import { getHandOffCount } from "../core/hand-off-cap";
import { buildKanbanRuntimeUrl, getKanbanRuntimeOrigin, getRuntimeFetch } from "../core/runtime-endpoint";
import {
	addTaskDependency,
	addTaskToColumn,
	deleteTasksFromBoard,
	getTaskColumnId,
	moveTaskToColumn,
	type RuntimeAddTaskDependencyResult,
	removeTaskDependency,
	updateTask,
} from "../core/task-board-mutations";
import { createUniqueTaskId } from "../core/task-id";
import { resolveProjectInputPath } from "../projects/project-path";
import { recordAgentScoreEvent } from "../state/agent-scores";
import {
	deleteTaskHistory,
	formatRecentTaskComments,
	loadTaskHistory,
	recordTaskHistoryEvent,
} from "../state/task-history";
import { getTaskWorktreesHomePath, loadWorkspaceContext, mutateWorkspaceState } from "../state/workspace-state";
import { KANBAN_HOOK_TASK_ID_ENV, KANBAN_HOOK_WORKSPACE_ID_ENV } from "../terminal/hook-runtime-context";
import type { RuntimeAppRouter } from "../trpc/app-router";
import { columnCanHaveLiveTaskSession, completeTaskToDone } from "../workspace/complete-task-to-done";
import { getWorkspaceFolderLabelForWorktreePath } from "../workspace/task-worktree-path";

const warnAgentScoreRecording = console.warn.bind(console);

const LIST_TASK_COLUMNS = ["backlog", "in_progress", "review", "trash"] as const;
type ListTaskColumn = (typeof LIST_TASK_COLUMNS)[number];
type TaskCommandTarget = { taskId?: string; column?: ListTaskColumn };

type ResolvedTaskCommandTarget =
	| {
			kind: "task";
			taskId: string;
	  }
	| {
			kind: "column";
			column: ListTaskColumn;
	  };

interface RuntimeWorkspaceMutationResult<T> {
	board: RuntimeWorkspaceStateResponse["board"];
	sessions?: RuntimeWorkspaceStateResponse["sessions"];
	value: T;
}

type JsonRecord = Record<string, unknown>;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}
	return String(error);
}

function printJson(payload: unknown): void {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printTextOrJson(payload: unknown): void {
	if (typeof payload === "object" && payload !== null && "text" in payload) {
		process.stdout.write(String(payload.text));
	} else {
		printJson(payload);
	}
}

function parseListColumn(value: string | undefined): ListTaskColumn | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "done") {
		return "trash";
	}
	if (value === "backlog" || value === "in_progress" || value === "review" || value === "trash") {
		return value;
	}
	throw new Error(`Invalid column "${value}". Expected one of: ${LIST_TASK_COLUMNS.join(", ")}, done.`);
}

function parseAutoReviewMode(value: string | undefined): "commit" | "pr" | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "commit" || value === "pr") {
		return value;
	}
	throw new Error(`Invalid auto review mode "${value}". Expected: commit, pr.`);
}

const VALID_AGENT_IDS_TEXT = RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS.join(" | ");

export function parseAgentId(value: string | undefined): RuntimeAgentId | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	const result = runtimeAgentIdSchema.safeParse(value);
	if (result.success && isRuntimeAgentLaunchSupported(result.data)) {
		return result.data;
	}
	const reason = result.success ? "is not supported for task launch" : "is not a known agent";
	throw new Error(
		`Invalid agent ID "${value}": ${reason}. Expected one of: ${RUNTIME_LAUNCH_SUPPORTED_AGENT_IDS.join(", ")}, default.`,
	);
}

function parseOptionalStringOrDefault(value: string | undefined): string | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === "default") {
		return null;
	}
	return value;
}

function parseTaskClaudeModel(value: string): RuntimeClaudeModel | "default" {
	if (value === "default") return "default";
	const result = runtimeClaudeModelSchema.safeParse(value);
	if (!result.success) throw new Error(`Invalid --model "${value}". Expected: haiku, sonnet, opus, default.`);
	return result.data;
}

function parseTaskDifficulty(value: string | undefined): TaskDifficulty | undefined {
	if (value === undefined) return undefined;
	const result = runtimeTaskDifficultySchema.safeParse(Number(value));
	if (!result.success) throw new Error(`Invalid --difficulty "${value}". Expected an integer from 1 to 5.`);
	return result.data;
}

// A key set to undefined clears that field; an absent key leaves it alone.
type TaskModelFields = Partial<
	Pick<RuntimeBoardCard, "difficulty" | "claudeModel" | "agentModel" | "agentReasoningEffort">
>;

function setTaskModelFields(
	board: RuntimeWorkspaceStateResponse["board"],
	taskId: string,
	fields: TaskModelFields,
): { board: RuntimeWorkspaceStateResponse["board"]; task: RuntimeBoardCard | null } {
	let task: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		if (!column.cards.some((card) => card.id === taskId)) return column;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) return card;
			const next: RuntimeBoardCard = { ...card, ...fields };
			for (const key of Object.keys(fields) as Array<keyof TaskModelFields>) {
				if (next[key] === undefined) delete next[key];
			}
			task = next;
			return next;
		});
		return { ...column, cards };
	});
	return { board: { ...board, columns }, task };
}

// A Claude alias or "default" needs no catalog. An unreachable catalog query means any id is accepted.
async function loadCatalogsForModel(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	model: string | undefined,
): Promise<RuntimeAgentModelCatalogsResponse | null> {
	if (model === undefined || model === "default" || isRuntimeClaudeModel(model)) return null;
	return await runtimeClient.runtime.getAgentModelCatalogs.query().catch(() => null);
}

function buildTaskModelFields(input: {
	agentId: string | null | undefined;
	model?: string;
	reasoningEffort?: string;
	difficulty?: TaskDifficulty;
	catalogs: RuntimeAgentModelCatalogsResponse | null;
}): TaskModelFields {
	const { agentId, model, reasoningEffort, difficulty, catalogs } = input;
	const fields: TaskModelFields = difficulty === undefined ? {} : { difficulty };
	if (model !== undefined) {
		if (agentId === "claude") {
			const claudeModel = parseTaskClaudeModel(model);
			fields.claudeModel = claudeModel === "default" ? undefined : claudeModel;
		} else if (agentId === "codex" || agentId === "opencode") {
			const catalog = catalogs?.[agentId];
			const unknown = catalog?.ok === true && !catalog.models.some(({ id }) => id === model);
			if (model !== "default" && (isRuntimeClaudeModel(model) || !model.trim() || unknown)) {
				throw new Error(`Invalid --model "${model}" for ${agentId}. Run task models to see the available models.`);
			}
			fields.agentModel = model === "default" ? undefined : model;
		} else {
			throw new Error("--model can only be used when the effective task agent is claude, codex, or opencode.");
		}
	}
	if (reasoningEffort !== undefined) {
		if (agentId !== "codex") {
			throw new Error("--reasoning-effort can only be used when the effective task agent is codex.");
		}
		if (!reasoningEffort.trim()) throw new Error("--reasoning-effort cannot be empty.");
		fields.agentReasoningEffort = reasoningEffort === "default" ? undefined : reasoningEffort;
	}
	return fields;
}

function formatTaskModelFields(task: RuntimeBoardCard): JsonRecord {
	return {
		...(task.difficulty ? { difficulty: task.difficulty } : {}),
		...(task.agentModel ? { agentModel: task.agentModel } : {}),
		...(task.agentReasoningEffort ? { agentReasoningEffort: task.agentReasoningEffort } : {}),
	};
}

type ParsedTaskClineReasoningEffort = RuntimeClineReasoningEffort | "default" | null | undefined;

function parseTaskClineReasoningEffort(value: string | undefined): ParsedTaskClineReasoningEffort {
	if (value === undefined) {
		return undefined;
	}
	if (value === "inherit") {
		return null;
	}
	if (value === "default") {
		return "default";
	}
	const result = runtimeClineReasoningEffortSchema.safeParse(value);
	if (result.success) {
		return result.data;
	}
	throw new Error("Invalid Cline reasoning effort. Expected one of: default, low, medium, high, xhigh, inherit.");
}

function cloneTaskClineSettings(settings?: RuntimeTaskClineSettings): RuntimeTaskClineSettings | undefined {
	if (settings === undefined) {
		return undefined;
	}
	const providerId = settings.providerId?.trim();
	const modelId = settings.modelId?.trim();
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
	};
}

function formatTaskClineSettings(settings?: RuntimeTaskClineSettings): JsonRecord {
	if (settings === undefined) {
		return {};
	}
	return {
		clineSettings: cloneTaskClineSettings(settings) ?? {},
	};
}

function buildTaskClineSettingsForCreate(input: {
	providerId?: string;
	modelId?: string;
	reasoningEffort?: ParsedTaskClineReasoningEffort;
}): RuntimeTaskClineSettings | undefined {
	const providerId = input.providerId?.trim();
	const modelId = input.modelId?.trim();
	const reasoningEffort = input.reasoningEffort === null ? undefined : input.reasoningEffort;
	if (!providerId && !modelId && reasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(reasoningEffort && reasoningEffort !== "default" ? { reasoningEffort } : {}),
	};
}

function buildTaskClineSettingsForUpdate(
	currentSettings: RuntimeTaskClineSettings | undefined,
	input: {
		providerId?: string | null;
		modelId?: string | null;
		reasoningEffort?: ParsedTaskClineReasoningEffort;
	},
): RuntimeTaskClineSettings | null | undefined {
	if (input.providerId === undefined && input.modelId === undefined && input.reasoningEffort === undefined) {
		return undefined;
	}
	const nextSettings = cloneTaskClineSettings(currentSettings) ?? {};
	let preserveEmptyOverride = currentSettings !== undefined && Object.keys(currentSettings).length === 0;

	if (input.providerId !== undefined) {
		const providerId = input.providerId?.trim();
		if (providerId) {
			nextSettings.providerId = providerId;
		} else {
			delete nextSettings.providerId;
		}
	}

	if (input.modelId !== undefined) {
		const modelId = input.modelId?.trim();
		if (modelId) {
			nextSettings.modelId = modelId;
		} else {
			delete nextSettings.modelId;
		}
	}

	if (input.reasoningEffort !== undefined) {
		if (input.reasoningEffort === "default") {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = true;
		} else if (input.reasoningEffort === null) {
			delete nextSettings.reasoningEffort;
			preserveEmptyOverride = false;
		} else {
			nextSettings.reasoningEffort = input.reasoningEffort;
		}
	}

	if (
		nextSettings.providerId === undefined &&
		nextSettings.modelId === undefined &&
		nextSettings.reasoningEffort === undefined &&
		!preserveEmptyOverride
	) {
		return null;
	}

	return nextSettings;
}

function resolveTaskCommandTarget(input: TaskCommandTarget, commandName: string): ResolvedTaskCommandTarget {
	const taskId = input.taskId?.trim();
	const column = input.column;
	if (taskId && column) {
		throw new Error(`${commandName} accepts exactly one of --task-id or --column.`);
	}
	if (taskId) {
		return {
			kind: "task",
			taskId,
		};
	}
	if (column) {
		return {
			kind: "column",
			column,
		};
	}
	throw new Error(`${commandName} requires either --task-id or --column.`);
}

function createRuntimeTrpcClient(workspaceId: string | null) {
	return createTRPCProxyClient<RuntimeAppRouter>({
		links: [
			httpBatchLink({
				url: buildKanbanRuntimeUrl("/api/trpc"),
				headers: () => (workspaceId ? { "x-kanban-workspace-id": workspaceId } : {}),
				fetch: async (url, options) => {
					const runtimeFetch = await getRuntimeFetch();
					return runtimeFetch(url, options);
				},
			}),
		],
	});
}

async function resolveRuntimeWorkspace(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
) {
	const normalizedProjectPath = (projectPath ?? "").trim();
	const resolvedPath = normalizedProjectPath ? resolveProjectInputPath(normalizedProjectPath, cwd) : cwd;
	return await loadWorkspaceContext(resolvedPath, {
		autoCreateIfMissing: options.autoCreateIfMissing ?? true,
	});
}

async function resolveWorkspaceRepoPath(
	projectPath: string | undefined,
	cwd: string,
	options: { autoCreateIfMissing?: boolean } = {},
): Promise<string> {
	const workspace = await resolveRuntimeWorkspace(projectPath, cwd, options);
	return workspace.repoPath;
}

async function ensureRuntimeWorkspace(workspaceRepoPath: string): Promise<string> {
	const runtimeClient = createRuntimeTrpcClient(null);
	const added = await runtimeClient.projects.add.mutate({
		path: workspaceRepoPath,
	});
	if (!added.ok || !added.project) {
		throw new Error(added.error ?? `Could not register project ${workspaceRepoPath} in Kanban runtime.`);
	}
	return added.project.id;
}

async function notifyRuntimeWorkspaceStateUpdated(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
): Promise<void> {
	await runtimeClient.workspace.notifyStateUpdated.mutate().catch(() => null);
}

async function recordReviewScore(input: {
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
	workspaceId: string;
	taskId: string;
	type: "pass" | "fail";
	detail?: string;
	commit?: string;
}): Promise<boolean> {
	try {
		const state = await input.runtimeClient.workspace.getState.query();
		const card = findTaskRecord(state, input.taskId)?.task;
		const config = await input.runtimeClient.runtime.getConfig.query();
		const agentId = card
			? resolveEffectiveTaskAgentId(card.agentId, state.sessions[input.taskId]?.agentId, config.selectedAgentId)
			: null;
		const scoreAgentId = agentId
			? resolveScoreAgentKey({
					agentId,
					sessionClaudeModel: state.sessions[input.taskId]?.claudeModel,
					sessionAgentModel: state.sessions[input.taskId]?.agentModel,
					cardClaudeModel: card?.claudeModel,
					defaultClaudeModel: config.claudeDefaultModel,
				})
			: null;
		if (
			!card ||
			!agentId ||
			getTaskColumnId(state.board, input.taskId) !== "review" ||
			card.agentReviewEnabled !== true ||
			(card.reviewRound ?? 0) < 1
		) {
			return false;
		}
		try {
			await recordTaskHistoryEvent(input.workspaceId, input.taskId, {
				type: input.type,
				agentId,
				round: card.reviewRound,
				detail: input.detail,
				commit: input.commit,
			});
		} catch (error) {
			warnAgentScoreRecording("Could not record task history event.", error);
		}
		const recorded = await recordAgentScoreEvent(input.workspaceId, {
			type: input.type,
			agentId: scoreAgentId ?? agentId,
			taskId: input.taskId,
			round: card.reviewRound,
		});
		if (recorded) {
			await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient);
		}
		return recorded;
	} catch (error) {
		warnAgentScoreRecording("Could not record agent score event.", error);
		return false;
	}
}

async function updateRuntimeWorkspaceState<T>(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	workspaceRepoPath: string,
	mutate: (state: RuntimeWorkspaceStateResponse) => RuntimeWorkspaceMutationResult<T>,
): Promise<T> {
	const mutationResponse = await mutateWorkspaceState(workspaceRepoPath, (state) => {
		const mutation = mutate(state);
		return {
			board: mutation.board,
			sessions: mutation.sessions,
			value: mutation.value,
		};
	});

	if (mutationResponse.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	return mutationResponse.value;
}

function resolveTaskBaseRef(state: RuntimeWorkspaceStateResponse): string {
	return state.git.currentBranch ?? state.git.defaultBranch ?? state.git.branches[0] ?? "";
}

function findTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	taskId: string,
): { task: RuntimeBoardCard; columnId: RuntimeBoardColumnId } | null {
	for (const column of state.board.columns) {
		const task = column.cards.find((candidate) => candidate.id === taskId);
		if (task) {
			return {
				task,
				columnId: column.id,
			};
		}
	}
	return null;
}

function formatTaskRecord(
	state: RuntimeWorkspaceStateResponse,
	task: RuntimeBoardCard,
	columnId: RuntimeBoardColumnId,
): JsonRecord {
	const session = state.sessions[task.id] ?? null;
	return {
		id: task.id,
		prompt: task.prompt,
		column: columnId,
		baseRef: task.baseRef,
		worktreePath: join(getTaskWorktreesHomePath(), task.id, getWorkspaceFolderLabelForWorktreePath(state.repoPath)),
		startInPlanMode: task.startInPlanMode,
		autoReviewEnabled: task.autoReviewEnabled === true,
		autoReviewMode: task.autoReviewMode ?? "commit",
		agentReviewEnabled: task.agentReviewEnabled === true,
		reviewRound: task.reviewRound ?? 0,
		handOffCount: getHandOffCount(task),
		...(task.agentId ? { agentId: task.agentId } : {}),
		...(task.claudeModel ? { claudeModel: task.claudeModel } : {}),
		...formatTaskModelFields(task),
		...formatTaskClineSettings(task.clineSettings),
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		session: session
			? {
					state: session.state,
					agentId: session.agentId,
					pid: session.pid,
					startedAt: session.startedAt,
					updatedAt: session.updatedAt,
					lastOutputAt: session.lastOutputAt,
					reviewReason: session.reviewReason,
					exitCode: session.exitCode,
				}
			: null,
	};
}

function setTaskAgentReviewEnabled(
	board: RuntimeWorkspaceStateResponse["board"],
	taskId: string,
	agentReviewEnabled: boolean,
): { board: RuntimeWorkspaceStateResponse["board"]; task: RuntimeBoardCard | null } {
	let updatedTask: RuntimeBoardCard | null = null;
	const columns = board.columns.map((column) => {
		let changed = false;
		const cards = column.cards.map((card) => {
			if (card.id !== taskId) {
				return card;
			}
			changed = true;
			updatedTask = { ...card, agentReviewEnabled };
			return updatedTask;
		});
		return changed ? { ...column, cards } : column;
	});
	if (!updatedTask) {
		return { board, task: null };
	}
	return { board: { ...board, columns }, task: updatedTask };
}

function formatDependencyRecord(
	state: RuntimeWorkspaceStateResponse,
	dependency: RuntimeBoardDependency,
): Record<string, unknown> {
	return {
		id: dependency.id,
		backlogTaskId: dependency.fromTaskId,
		backlogTaskColumn: getTaskColumnId(state.board, dependency.fromTaskId),
		linkedTaskId: dependency.toTaskId,
		linkedTaskColumn: getTaskColumnId(state.board, dependency.toTaskId),
		createdAt: dependency.createdAt,
	};
}

function getLinkFailureMessage(reason: RuntimeAddTaskDependencyResult["reason"]): string {
	if (reason === "same_task") {
		return "A task cannot be linked to itself.";
	}
	if (reason === "duplicate") {
		return "These tasks are already linked.";
	}
	if (reason === "trash_task") {
		return "Links cannot include done tasks.";
	}
	if (reason === "non_backlog") {
		return "Links require at least one backlog task.";
	}
	return "One or both tasks could not be found.";
}

function findTasksInColumn(
	state: RuntimeWorkspaceStateResponse,
	columnId: ListTaskColumn,
): Array<{ task: RuntimeBoardCard; columnId: RuntimeBoardColumnId }> {
	const column = state.board.columns.find((candidate) => candidate.id === columnId);
	if (!column) {
		return [];
	}
	return column.cards.map((task) => ({
		task,
		columnId: column.id,
	}));
}

async function listTasks(input: {
	cwd: string;
	projectPath?: string;
	column?: ListTaskColumn;
	all?: boolean;
}): Promise<{ full: JsonRecord; compact: ReturnType<typeof compactTaskList> }> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, {
		autoCreateIfMissing: false,
	});
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const state = await runtimeClient.workspace.getState.query();

	const tasks = state.board.columns.flatMap((boardColumn) => {
		if (!input.column && boardColumn.id === "trash") {
			return [];
		}
		if (input.column && boardColumn.id !== input.column) {
			return [];
		}
		return boardColumn.cards.map((task) => formatTaskRecord(state, task, boardColumn.id));
	});

	return {
		full: {
			ok: true,
			workspacePath: workspace.repoPath,
			column: input.column ?? null,
			tasks,
			dependencies: state.board.dependencies.map((dependency) => formatDependencyRecord(state, dependency)),
			count: tasks.length,
		},
		compact: compactTaskList(state, input.column, input.all === true),
	};
}

type CompactTaskListRow = {
	id: string;
	column: string;
	agentId: string | null;
	reviewRound: number;
	handOffCount: number;
	session: string | null;
	title: string;
	agentReviewEnabled: boolean;
	difficulty?: TaskDifficulty;
};

function compactTaskList(
	state: RuntimeWorkspaceStateResponse,
	column?: ListTaskColumn,
	all = false,
): {
	tasks: CompactTaskListRow[];
	doneHidden: number;
	dependencies: Array<{ taskId: string; linkedTaskId: string; dependencyId: string }>;
	lastCreated: { id: string; agentId: string | null } | null;
} {
	const done = state.board.columns.find(({ id }) => id === "trash")?.cards ?? [];
	const hiddenDone = !all && !column ? Math.max(0, done.length - 3) : 0;
	const tasks: CompactTaskListRow[] = state.board.columns.flatMap((boardColumn) => {
		if (column && boardColumn.id !== column) return [];
		const cards = boardColumn.id === "trash" && !column && !all ? boardColumn.cards.slice(0, 3) : boardColumn.cards;
		return cards.map((task) => {
			const session = state.sessions[task.id];
			return {
				id: task.id,
				column: boardColumn.id === "trash" ? "done" : boardColumn.id,
				agentId: task.agentId ?? null,
				reviewRound: task.reviewRound ?? 0,
				handOffCount: getHandOffCount(task),
				session: session?.state ?? null,
				title: task.title || task.prompt.split(/\r?\n/u, 1)[0]?.slice(0, 80) || "",
				agentReviewEnabled: task.agentReviewEnabled === true,
				...(task.difficulty ? { difficulty: task.difficulty } : {}),
			};
		});
	});
	const newest = state.board.columns
		.flatMap(({ cards }) => cards)
		.reduce<RuntimeBoardCard | null>(
			(current, task) => (!current || task.createdAt > current.createdAt ? task : current),
			null,
		);
	return {
		tasks,
		doneHidden: hiddenDone,
		dependencies: state.board.dependencies.map((dependency) => ({
			taskId: dependency.fromTaskId,
			linkedTaskId: dependency.toTaskId,
			dependencyId: dependency.id,
		})),
		lastCreated: newest ? { id: newest.id, agentId: newest.agentId ?? null } : null,
	};
}

function formatTaskListText(list: ReturnType<typeof compactTaskList>): string {
	const widths = {
		id: Math.max(5, ...list.tasks.map(({ id }) => id.slice(0, 5).length)),
		column: Math.max(6, ...list.tasks.map(({ column }) => column.length)),
		agent: Math.max(5, ...list.tasks.map(({ agentId }) => (agentId ?? "-").length)),
		review: Math.max(
			4,
			...list.tasks.map(({ reviewRound, handOffCount, agentReviewEnabled }) =>
				agentReviewEnabled ? `r${reviewRound}/${3 * (handOffCount + 1)}`.length : 1,
			),
		),
		handoff: Math.max(2, ...list.tasks.map(({ handOffCount }) => `h${handOffCount}`.length)),
		session: Math.max(7, ...list.tasks.map(({ session }) => (session ?? "-").length)),
	};
	const lines = list.tasks.map((task) => {
		const round = task.agentReviewEnabled ? `r${task.reviewRound}/${3 * (task.handOffCount + 1)}` : "-";
		return `${task.id.slice(0, 5).padEnd(widths.id)}  ${task.column.padEnd(widths.column)}  ${(task.agentId ?? "-").padEnd(widths.agent)}  ${round.padEnd(widths.review)}  ${`h${task.handOffCount}`.padEnd(widths.handoff)}  ${(task.session ?? "-").padEnd(widths.session)}  ${task.difficulty ? `d${task.difficulty} ` : ""}${task.title}`;
	});
	if (list.doneHidden > 0) {
		lines.push(`(${list.doneHidden} more done not shown; pass --column done or --all)`);
	}
	for (const dependency of list.dependencies) {
		lines.push(`links: ${dependency.taskId} waits on ${dependency.linkedTaskId} (dep ${dependency.dependencyId})`);
	}
	if (list.lastCreated) {
		lines.push(`last created: ${list.lastCreated.id} (${list.lastCreated.agentId ?? "-"})`);
	}
	return `${lines.join("\n")}\n`;
}

const TASK_MODEL_AGENTS = ["codex", "opencode", "claude"] as const;
type TaskModelAgent = (typeof TASK_MODEL_AGENTS)[number];

function isScoreKeyOfAgent(key: string, agent: TaskModelAgent): boolean {
	if (agent === "claude") return key === "claude" || isRuntimeClaudeModel(key);
	return key === agent || key.startsWith(`${agent}:`);
}

function formatTaskModels(
	agent: TaskModelAgent,
	map: DifficultyModelMap,
	catalogs: RuntimeAgentModelCatalogsResponse,
	scores: NonNullable<RuntimeWorkspaceStateResponse["agentScores"]>,
): string {
	const catalog = catalogs[agent];
	const agentScores = scores.filter(({ agentId }) => isScoreKeyOfAgent(agentId, agent));
	return [
		agent,
		"  Difficulty table:",
		...([1, 2, 3, 4, 5] as const).map((difficulty) => {
			const cell: DifficultyModelCell | undefined = map[agent]?.[difficulty];
			const effort = cell?.reasoningEffort ? `/${cell.reasoningEffort}` : "";
			return `    ${difficulty} → ${cell?.model ? `${cell.model}${effort}` : "default"}`;
		}),
		"  Models:",
		...(catalog.ok
			? catalog.models.map(({ id, description, efforts }) => {
					const about = description ? ` — ${description}` : "";
					return `    ${id}${about}${efforts.length > 0 ? ` [${efforts.join(",")}]` : ""}`;
				})
			: [`    catalog unavailable: ${catalog.error}`]),
		"  Scores (pass/fail):",
		...(agentScores.length > 0
			? agentScores.map(
					({ agentId, passes, fails }) => `    ${agentId === agent ? "default" : agentId} ${passes}/${fails}`,
				)
			: ["    none"]),
	].join("\n");
}

async function listTaskModels(input: { cwd: string; projectPath?: string; agent?: string }): Promise<JsonRecord> {
	const agents = TASK_MODEL_AGENTS.filter((agent) => input.agent === undefined || agent === input.agent);
	if (agents.length === 0) {
		throw new Error(`Invalid --agent "${input.agent}". Expected one of: ${TASK_MODEL_AGENTS.join(", ")}.`);
	}
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, { autoCreateIfMissing: false });
	const runtimeClient = createRuntimeTrpcClient(workspace.workspaceId);
	const [config, catalogs, state] = await Promise.all([
		runtimeClient.runtime.getConfig.query(),
		runtimeClient.runtime.getAgentModelCatalogs.query(),
		runtimeClient.workspace.getState.query(),
	]);
	const sections = agents.map((agent) =>
		formatTaskModels(agent, config.difficultyModelMap ?? {}, catalogs, state.agentScores ?? []),
	);
	return { text: `${sections.join("\n\n")}\n` };
}

function compactTaskListJson(list: ReturnType<typeof compactTaskList>): JsonRecord {
	return {
		ok: true,
		tasks: list.tasks.map(({ agentReviewEnabled: _agentReviewEnabled, ...task }) => task),
		doneHidden: list.doneHidden,
		dependencies: list.dependencies,
		lastCreated: list.lastCreated,
	};
}

async function showTask(input: { cwd: string; projectPath?: string; taskId: string }): Promise<JsonRecord> {
	const workspace = await resolveRuntimeWorkspace(input.projectPath, input.cwd, { autoCreateIfMissing: false });
	const state = await createRuntimeTrpcClient(workspace.workspaceId).workspace.getState.query();
	const record = findTaskRecord(state, input.taskId);
	if (!record) {
		throw new Error(`Task not found: ${input.taskId}`);
	}
	const comments = (await loadTaskHistory(workspace.workspaceId, input.taskId))
		.filter((event) => event.type === "comment" && event.detail !== undefined)
		.map(({ agentId, at, detail }) => ({ agentId, at, body: detail }));
	const issueState = await createRuntimeTrpcClient(workspace.workspaceId).workspace.getGithubIssues.query();
	return {
		ok: true,
		task: {
			...formatTaskRecord(state, record.task, record.columnId),
			comments,
			issueReport: issueState.reports[input.taskId] ?? "none",
			issueSyncEnabled: issueState.enabled,
			...(issueState.issues[input.taskId]
				? { issueNumber: issueState.issues[input.taskId]?.number, issueUrl: issueState.issues[input.taskId]?.url }
				: {}),
		},
	};
}

async function commentOnTask(input: {
	cwd: string;
	projectPath?: string;
	taskId?: string;
	message: string;
}): Promise<JsonRecord> {
	const taskId = input.taskId?.trim() || process.env[KANBAN_HOOK_TASK_ID_ENV]?.trim();
	if (!taskId) throw new Error("task comment requires --task-id or KANBAN_HOOK_TASK_ID.");
	const workspaceId = input.projectPath
		? (await resolveRuntimeWorkspace(input.projectPath, input.cwd, { autoCreateIfMissing: false })).workspaceId
		: process.env[KANBAN_HOOK_WORKSPACE_ID_ENV]?.trim() ||
			(await resolveRuntimeWorkspace(undefined, input.cwd, { autoCreateIfMissing: false })).workspaceId;
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const state = await runtimeClient.workspace.getState.query();
	const record = findTaskRecord(state, taskId);
	if (!record) throw new Error(`Task not found: ${taskId}`);
	const agentId = record.task.agentId ?? state.sessions[taskId]?.agentId ?? "user";
	await recordTaskHistoryEvent(workspaceId, taskId, {
		type: "comment",
		agentId,
		detail: input.message,
	});
	return { ok: true, taskId };
}

async function stopTaskRuntimeSession(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<void> {
	await runtimeClient.runtime.stopTaskSession
		.mutate({
			taskId,
		})
		.catch(() => null);
}

async function deleteTaskWorkspace(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	taskId: string,
): Promise<{ removed: boolean; error?: string }> {
	try {
		const deleted = await runtimeClient.workspace.deleteWorktree.mutate({
			taskId,
		});
		return {
			removed: deleted.removed,
			error: deleted.ok ? undefined : deleted.error,
		};
	} catch (error) {
		return {
			removed: false,
			error: toErrorMessage(error),
		};
	}
}

// The issue summary must be stored before the task reaches the board, so the GitHub
// sync never creates the issue without it. Returns the pre-generated task id.
async function storeTaskIssueFields(
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>,
	input: { summary?: string; metadata?: TaskIssueMetadata },
): Promise<string | undefined> {
	const trimmed = input.summary?.trim();
	if (!trimmed && !input.metadata) {
		return undefined;
	}
	let storing = trimmed ? "summary" : "metadata";
	try {
		const state = await runtimeClient.workspace.getState.query();
		const existingIds = new Set(state.board.columns.flatMap((column) => column.cards.map((card) => card.id)));
		const taskId = createUniqueTaskId(existingIds, () => globalThis.crypto.randomUUID());
		if (trimmed) await runtimeClient.workspace.setTaskIssueSummary.mutate({ taskId, summary: trimmed });
		storing = "metadata";
		if (input.metadata) await runtimeClient.workspace.setTaskIssueMetadata.mutate({ taskId, ...input.metadata });
		return taskId;
	} catch (error) {
		process.stderr.write(`Warning: could not store the issue ${storing}: ${toErrorMessage(error)}\n`);
		return undefined;
	}
}

interface TaskIssueMetadata {
	labels?: string[];
	milestone?: string;
	assignee?: string;
}

// Returns undefined when no metadata option was given, so callers skip the runtime call.
function parseTaskIssueMetadata(options: {
	labels?: string;
	milestone?: string;
	assignee?: string;
}): TaskIssueMetadata | undefined {
	const labels = options.labels
		?.split(",")
		.map((label) => label.trim())
		.filter(Boolean);
	const milestone = options.milestone?.trim();
	const assignee = options.assignee?.trim();
	if (!labels?.length && !milestone && !assignee) return undefined;
	return {
		...(labels?.length ? { labels } : {}),
		...(milestone ? { milestone } : {}),
		...(assignee ? { assignee } : {}),
	};
}

async function createTask(input: {
	cwd: string;
	title?: string;
	prompt: string;
	projectPath?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	agentReviewEnabled?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId;
	model?: string;
	reasoningEffort?: string;
	difficulty?: string;
	clineSettings?: RuntimeTaskClineSettings;
	summary?: string;
	issueMetadata?: TaskIssueMetadata;
}): Promise<JsonRecord> {
	const difficulty = parseTaskDifficulty(input.difficulty);
	const configClient = createRuntimeTrpcClient(null);
	const config =
		input.model !== undefined || input.reasoningEffort !== undefined
			? await configClient.runtime.getConfig.query()
			: null;
	const modelFields = buildTaskModelFields({
		agentId: input.agentId ?? config?.selectedAgentId,
		model: input.model,
		reasoningEffort: input.reasoningEffort,
		difficulty,
		catalogs: await loadCatalogsForModel(configClient, input.model),
	});
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const taskId = await storeTaskIssueFields(runtimeClient, { summary: input.summary, metadata: input.issueMetadata });
	const created = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (state) => {
		const resolvedBaseRef = (input.baseRef ?? "").trim() || resolveTaskBaseRef(state);
		if (!resolvedBaseRef) {
			throw new Error("Could not determine task base branch for this workspace.");
		}
		const result = addTaskToColumn(
			state.board,
			"backlog",
			{
				taskId,
				title: input.title,
				prompt: input.prompt,
				startInPlanMode: input.startInPlanMode,
				autoReviewEnabled: input.autoReviewEnabled,
				autoReviewMode: input.autoReviewMode,
				agentId: input.agentId,
				clineSettings: input.clineSettings,
				baseRef: resolvedBaseRef,
			},
			() => globalThis.crypto.randomUUID(),
		);
		const modeled = setTaskModelFields(result.board, result.task.id, modelFields);
		const reviewed = setTaskAgentReviewEnabled(modeled.board, result.task.id, input.agentReviewEnabled ?? true);
		return {
			board: reviewed.board,
			value: reviewed.task ?? result.task,
		};
	});

	return {
		ok: true,
		task: {
			id: created.id,
			column: "backlog",
			workspacePath: workspaceRepoPath,
			title: created.title,
			prompt: created.prompt,
			baseRef: created.baseRef,
			startInPlanMode: created.startInPlanMode,
			autoReviewEnabled: created.autoReviewEnabled === true,
			autoReviewMode: created.autoReviewMode ?? "commit",
			agentReviewEnabled: created.agentReviewEnabled === true,
			...(created.agentId ? { agentId: created.agentId } : {}),
			...(created.claudeModel ? { claudeModel: created.claudeModel } : {}),
			...formatTaskModelFields(created),
			...formatTaskClineSettings(created.clineSettings),
		},
	};
}

async function updateTaskCommand(input: {
	cwd: string;
	taskId: string;
	title?: string;
	projectPath?: string;
	prompt?: string;
	baseRef?: string;
	startInPlanMode?: boolean;
	agentReviewEnabled?: boolean;
	autoReviewEnabled?: boolean;
	autoReviewMode?: "commit" | "pr";
	agentId?: RuntimeAgentId | null;
	model?: string;
	reasoningEffort?: string;
	difficulty?: string;
	clineProviderId?: string | null;
	clineModelId?: string | null;
	clineReasoningEffort?: ParsedTaskClineReasoningEffort;
	summary?: string;
	issueMetadata?: TaskIssueMetadata;
}): Promise<JsonRecord> {
	const summary = input.summary?.trim();
	if (input.summary !== undefined && !summary) throw new Error("Task issue summary must not be empty.");
	if (
		input.title === undefined &&
		input.prompt === undefined &&
		input.baseRef === undefined &&
		input.startInPlanMode === undefined &&
		input.agentReviewEnabled === undefined &&
		input.autoReviewEnabled === undefined &&
		input.autoReviewMode === undefined &&
		input.agentId === undefined &&
		input.model === undefined &&
		input.reasoningEffort === undefined &&
		input.difficulty === undefined &&
		input.clineProviderId === undefined &&
		input.clineModelId === undefined &&
		input.clineReasoningEffort === undefined &&
		input.summary === undefined &&
		input.issueMetadata === undefined
	) {
		throw new Error("task update requires at least one field to change.");
	}

	const difficulty = parseTaskDifficulty(input.difficulty);
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	if (summary || input.issueMetadata) {
		const state = await runtimeClient.workspace.getState.query();
		if (!state.board.columns.some((column) => column.cards.some((card) => card.id === input.taskId)))
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		if (summary) await runtimeClient.workspace.setTaskIssueSummary.mutate({ taskId: input.taskId, summary });
		if (input.issueMetadata)
			await runtimeClient.workspace.setTaskIssueMetadata.mutate({ taskId: input.taskId, ...input.issueMetadata });
	}
	const config =
		input.model !== undefined || input.reasoningEffort !== undefined
			? await runtimeClient.runtime.getConfig.query()
			: null;
	const catalogs = await loadCatalogsForModel(runtimeClient, input.model);
	const updated = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const taskRecord = findTaskRecord(runtimeState, input.taskId);
		if (!taskRecord) {
			throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
		}
		const effectiveAgentId =
			input.agentId !== undefined
				? (input.agentId ?? config?.selectedAgentId)
				: (taskRecord.task.agentId ?? config?.selectedAgentId);
		const modelFields = buildTaskModelFields({
			agentId: effectiveAgentId,
			model: input.model,
			reasoningEffort: input.reasoningEffort,
			difficulty,
			catalogs,
		});
		const nextTaskClineSettings = buildTaskClineSettingsForUpdate(taskRecord.task.clineSettings, {
			providerId: input.clineProviderId,
			modelId: input.clineModelId,
			reasoningEffort: input.clineReasoningEffort,
		});

		const updatedTask = updateTask(runtimeState.board, input.taskId, {
			title: input.title ?? taskRecord.task.title,
			prompt: input.prompt ?? taskRecord.task.prompt,
			baseRef: input.baseRef ?? taskRecord.task.baseRef,
			startInPlanMode: input.startInPlanMode ?? taskRecord.task.startInPlanMode,
			autoReviewEnabled: input.autoReviewEnabled ?? taskRecord.task.autoReviewEnabled === true,
			autoReviewMode: input.autoReviewMode ?? taskRecord.task.autoReviewMode ?? "commit",
			agentId: input.agentId,
			clineSettings: nextTaskClineSettings,
		});
		if (!updatedTask.updated || !updatedTask.task) {
			throw new Error(`Task "${input.taskId}" could not be updated.`);
		}
		// An explicit agent model belongs to the card's agent, so a new agent must not inherit it.
		const agentChanged = input.agentId !== undefined && (input.agentId ?? undefined) !== taskRecord.task.agentId;
		const agentUpdated = agentChanged
			? setTaskModelFields(updatedTask.board, input.taskId, {
					agentModel: undefined,
					agentReasoningEffort: undefined,
				})
			: { board: updatedTask.board, task: updatedTask.task };
		const modelUpdated = setTaskModelFields(agentUpdated.board, input.taskId, modelFields);

		const reviewed =
			input.agentReviewEnabled === undefined
				? { board: modelUpdated.board, task: modelUpdated.task }
				: setTaskAgentReviewEnabled(modelUpdated.board, input.taskId, input.agentReviewEnabled);

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: reviewed.board,
		};

		return {
			board: reviewed.board,
			value: formatTaskRecord(nextState, reviewed.task ?? updatedTask.task, taskRecord.columnId),
		};
	});

	return {
		ok: true,
		task: updated,
		workspacePath: workspaceRepoPath,
	};
}

async function linkTasks(input: {
	cwd: string;
	taskId: string;
	linkedTaskId: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const dependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const linked = addTaskDependency(runtimeState.board, input.taskId, input.linkedTaskId);
		if (!linked.added || !linked.dependency) {
			throw new Error(getLinkFailureMessage(linked.reason));
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: linked.board,
		};
		return {
			board: linked.board,
			value: formatDependencyRecord(nextState, linked.dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		dependency,
	};
}

async function unlinkTasks(input: { cwd: string; dependencyId: string; projectPath?: string }): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const removedDependency = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (runtimeState) => {
		const dependency =
			runtimeState.board.dependencies.find((candidate) => candidate.id === input.dependencyId) ?? null;
		if (!dependency) {
			throw new Error(`Dependency "${input.dependencyId}" was not found in workspace ${workspaceRepoPath}.`);
		}

		const unlinked = removeTaskDependency(runtimeState.board, input.dependencyId);
		if (!unlinked.removed) {
			throw new Error(`Dependency "${input.dependencyId}" could not be removed.`);
		}

		const nextState: RuntimeWorkspaceStateResponse = {
			...runtimeState,
			board: unlinked.board,
		};
		return {
			board: unlinked.board,
			value: formatDependencyRecord(nextState, dependency),
		};
	});
	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		removedDependency,
	};
}

export function buildRestartPrompt(input: {
	originalPrompt: string;
	baseRef: string;
	message?: string;
	comments?: string;
}): string {
	const prompt = `${input.originalPrompt}\n\n---\n[Kanban restart] Earlier work on this task is already in this worktree (uncommitted changes and commits since ${input.baseRef}). Check it and continue from it; do not start over.${input.message !== undefined ? `\nReviewer notes:\n${input.message}` : ""}`;
	return input.comments ? `${prompt}\n\n${input.comments}` : prompt;
}

async function startTask(input: {
	cwd: string;
	taskId: string;
	projectPath?: string;
	message?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const runtimeState = await runtimeClient.workspace.getState.query();
	const fromColumnId = getTaskColumnId(runtimeState.board, input.taskId);
	if (!fromColumnId) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${workspaceRepoPath}.`);
	}

	if (fromColumnId !== "backlog" && fromColumnId !== "in_progress" && fromColumnId !== "review") {
		throw new Error(
			`Task "${input.taskId}" is in "${fromColumnId}" and can only be started from backlog, in_progress, or review.`,
		);
	}

	const currentRecord = findTaskRecord(runtimeState, input.taskId);
	const task = currentRecord?.task;
	if (!task) {
		throw new Error(`Task "${input.taskId}" could not be resolved.`);
	}

	const existingSession = runtimeState.sessions[task.id] ?? null;
	const runtimeConfig = await runtimeClient.runtime.getConfig.query();
	const effectiveAgentId = task.agentId ?? runtimeConfig.selectedAgentId;
	const sessionIsLive =
		existingSession?.pid != null &&
		(existingSession.state === "running" || existingSession.state === "awaiting_review");
	const shouldStartSession = !existingSession || !sessionIsLive || existingSession.agentId !== effectiveAgentId;
	if (fromColumnId === "review" && sessionIsLive && existingSession.agentId === effectiveAgentId) {
		throw new Error(`Task "${input.taskId}" is in review with a live session; use task send instead.`);
	}

	let startedSummary: RuntimeWorkspaceStateResponse["sessions"][string] | null = null;
	if (shouldStartSession) {
		const comments =
			fromColumnId === "review" || input.message !== undefined
				? formatRecentTaskComments(await loadTaskHistory(workspaceId, task.id))
				: "";
		const ensured = await runtimeClient.workspace.ensureWorktree.mutate({
			taskId: task.id,
			baseRef: task.baseRef,
		});
		if (!ensured.ok) {
			throw new Error(ensured.error ?? "Could not ensure task worktree.");
		}

		const started = await runtimeClient.runtime.startTaskSession.mutate({
			taskId: task.id,
			prompt:
				fromColumnId === "review" || input.message !== undefined
					? buildRestartPrompt({
							originalPrompt: task.prompt,
							baseRef: task.baseRef,
							message: input.message,
							comments,
						})
					: task.prompt,
			taskTitle: task.title,
			startInPlanMode: task.startInPlanMode,
			baseRef: task.baseRef,
			agentId: task.agentId,
			clineSettings: task.clineSettings,
		});
		if (!started.ok || !started.summary) {
			throw new Error(started.error ?? "Could not start task session.");
		}
		startedSummary = started.summary;
	}

	const moved = await updateRuntimeWorkspaceState(runtimeClient, workspaceRepoPath, (latestState) => {
		const movement = moveTaskToColumn(latestState.board, input.taskId, "in_progress");
		if (!movement.task) {
			throw new Error(`Task "${input.taskId}" could not be resolved.`);
		}
		// The GitHub issue comment reads the launched model from the saved session record.
		const sessions = startedSummary ? { ...latestState.sessions, [input.taskId]: startedSummary } : undefined;
		if (!movement.moved) {
			return {
				board: latestState.board,
				sessions,
				value: movement,
			};
		}
		return {
			board: movement.board,
			sessions,
			value: movement,
		};
	});

	if (!moved.moved) {
		return {
			ok: true,
			message: `Task "${input.taskId}" is already in progress.`,
			task: {
				id: task.id,
				prompt: task.prompt,
				column: "in_progress",
				workspacePath: workspaceRepoPath,
			},
		};
	}

	return {
		ok: true,
		task: {
			id: task.id,
			prompt: task.prompt,
			column: "in_progress",
			workspacePath: workspaceRepoPath,
		},
	};
}

async function sendTaskMessage(input: {
	cwd: string;
	taskId: string;
	message: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const response = await runtimeClient.runtime.sendTaskMessage.mutate({
		taskId: input.taskId,
		message: input.message,
	});
	if (!response.ok) {
		throw new Error(response.error ?? `Task "${input.taskId}" session is not running.`);
	}
	return {
		ok: true,
		taskId: input.taskId,
	};
}

async function handOffTask(input: {
	cwd: string;
	taskId: string;
	message: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const response = await runtimeClient.runtime.handOffTask.mutate({
		taskId: input.taskId,
		reason: input.message,
	});
	if (!response.ok) {
		throw new Error(response.error ?? `Task "${input.taskId}" could not be handed off.`);
	}
	return {
		ok: true,
		taskId: input.taskId,
		fromAgentId: response.fromAgentId,
		toAgentId: response.toAgentId,
	};
}

interface TrashTaskExecutionResult {
	task: JsonRecord;
	taskId: string;
	previousColumnId: RuntimeBoardColumnId;
	readyTaskIds: string[];
	autoStartedTasks: JsonRecord[];
	worktreeDeleted: boolean;
	worktreeDeleteError?: string;
	alreadyInTrash: boolean;
}

async function trashTaskById(input: {
	cwd: string;
	taskId: string;
	reviewPassed?: boolean;
	projectPath?: string;
	workspaceRepoPath: string;
	runtimeClient: ReturnType<typeof createRuntimeTrpcClient>;
}): Promise<TrashTaskExecutionResult> {
	const autoStartedTasks: JsonRecord[] = [];
	const completed = await completeTaskToDone({
		repoPath: input.workspaceRepoPath,
		taskId: input.taskId,
		reviewPassed: input.reviewPassed,
		deps: {
			stopTaskSession: async (taskId) => await stopTaskRuntimeSession(input.runtimeClient, taskId),
			startTask: async (taskId) => {
				const started = await startTask({
					cwd: input.cwd,
					taskId,
					projectPath: input.projectPath,
				});
				autoStartedTasks.push(started);
				return started;
			},
			deleteTaskWorktree: async (taskId) => await deleteTaskWorkspace(input.runtimeClient, taskId),
			notifyStateUpdated: async () => await notifyRuntimeWorkspaceStateUpdated(input.runtimeClient),
		},
	});

	if (!completed.previousColumnId || !completed.task) {
		throw new Error(`Task "${input.taskId}" was not found in workspace ${input.workspaceRepoPath}.`);
	}

	return {
		task: formatTaskRecord(
			completed.state,
			completed.task,
			completed.alreadyInTrash ? completed.previousColumnId : "trash",
		),
		taskId: input.taskId,
		previousColumnId: completed.previousColumnId,
		readyTaskIds: completed.readyTaskIds,
		autoStartedTasks,
		worktreeDeleted: completed.worktreeDeleted,
		worktreeDeleteError: completed.worktreeDeleteError,
		alreadyInTrash: completed.alreadyInTrash,
	};
}

async function trashTask(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
	reviewPassed?: boolean;
	commit?: string;
}): Promise<JsonRecord> {
	if (input.reviewPassed && !input.taskId?.trim()) {
		throw new Error("--review-passed requires --task-id");
	}
	const target = resolveTaskCommandTarget(input, "task done");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);

	if (target.kind === "task") {
		if (input.reviewPassed) {
			await recordReviewScore({
				runtimeClient,
				workspaceId,
				taskId: target.taskId,
				type: "pass",
				commit: input.commit,
			});
		}
		const trashed = await trashTaskById({
			cwd: input.cwd,
			taskId: target.taskId,
			reviewPassed: input.reviewPassed,
			projectPath: input.projectPath,
			workspaceRepoPath,
			runtimeClient,
		});
		if (trashed.alreadyInTrash) {
			return {
				ok: true,
				message: `Task "${target.taskId}" is already done.`,
				task: trashed.task,
				workspacePath: workspaceRepoPath,
				readyTaskIds: [],
				autoStartedTasks: [],
			};
		}
		return {
			ok: true,
			task: trashed.task,
			workspacePath: workspaceRepoPath,
			readyTaskIds: trashed.readyTaskIds,
			autoStartedTasks: trashed.autoStartedTasks,
			worktreeDeleted: trashed.worktreeDeleted,
			worktreeDeleteError: trashed.worktreeDeleteError,
		};
	}

	const initialState = await runtimeClient.workspace.getState.query();
	const targetTasks = findTasksInColumn(initialState, target.column);
	if (targetTasks.length === 0) {
		return {
			ok: true,
			column: target.column,
			workspacePath: workspaceRepoPath,
			trashedTasks: [],
			alreadyTrashedTasks: [],
			readyTaskIds: [],
			autoStartedTasks: [],
			worktreeCleanup: [],
			count: 0,
		};
	}

	const results: TrashTaskExecutionResult[] = [];
	for (const { task } of targetTasks) {
		results.push(
			await trashTaskById({
				cwd: input.cwd,
				taskId: task.id,
				projectPath: input.projectPath,
				workspaceRepoPath,
				runtimeClient,
			}),
		);
	}

	const trashedTasks = results.filter((result) => !result.alreadyInTrash);
	const alreadyTrashedTasks = results.filter((result) => result.alreadyInTrash);

	return {
		ok: true,
		column: target.column,
		workspacePath: workspaceRepoPath,
		trashedTasks: trashedTasks.map((result) => result.task),
		alreadyTrashedTasks: alreadyTrashedTasks.map((result) => result.task),
		readyTaskIds: [...new Set(trashedTasks.flatMap((result) => result.readyTaskIds))],
		autoStartedTasks: trashedTasks.flatMap((result) => result.autoStartedTasks),
		worktreeCleanup: trashedTasks.map((result) => ({
			taskId: result.taskId,
			removed: result.worktreeDeleted,
			error: result.worktreeDeleteError,
		})),
		count: trashedTasks.length,
	};
}

async function reviewFailed(input: {
	cwd: string;
	taskId: string;
	message?: string;
	projectPath?: string;
}): Promise<JsonRecord> {
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const recorded = await recordReviewScore({
		runtimeClient,
		workspaceId,
		taskId: input.taskId,
		type: "fail",
		detail: input.message,
	});
	return { ok: true, taskId: input.taskId, recorded };
}

async function deleteTaskCommand(input: {
	cwd: string;
	taskId?: string;
	column?: ListTaskColumn;
	projectPath?: string;
}): Promise<JsonRecord> {
	const target = resolveTaskCommandTarget(input, "task delete");
	const workspaceRepoPath = await resolveWorkspaceRepoPath(input.projectPath, input.cwd);
	const workspaceId = await ensureRuntimeWorkspace(workspaceRepoPath);
	const runtimeClient = createRuntimeTrpcClient(workspaceId);
	const mutation = await mutateWorkspaceState(workspaceRepoPath, (latestState) => {
		const latestTargetRecords =
			target.kind === "task"
				? (() => {
						const record = findTaskRecord(latestState, target.taskId);
						if (!record) {
							throw new Error(`Task "${target.taskId}" was not found in workspace ${workspaceRepoPath}.`);
						}
						return [record];
					})()
				: findTasksInColumn(latestState, target.column);

		if (latestTargetRecords.length === 0) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deleted = deleteTasksFromBoard(
			latestState.board,
			latestTargetRecords.map(({ task }) => task.id),
		);
		if (!deleted.deleted) {
			return {
				board: latestState.board,
				value: {
					deletedTaskIds: [] as string[],
					taskIdsRequiringStop: [] as string[],
					deletedTasks: [] as JsonRecord[],
				},
				save: false,
			};
		}

		const deletedTasks = latestTargetRecords.map(({ task, columnId }) =>
			formatTaskRecord(latestState, task, columnId),
		);
		const taskIdsRequiringStop = latestTargetRecords
			.filter(({ columnId }) => columnCanHaveLiveTaskSession(columnId))
			.map(({ task }) => task.id);
		return {
			board: deleted.board,
			value: {
				deletedTaskIds: deleted.deletedTaskIds,
				taskIdsRequiringStop,
				deletedTasks,
			},
		};
	});

	if (mutation.saved) {
		await notifyRuntimeWorkspaceStateUpdated(runtimeClient);
	}

	if (mutation.value.deletedTaskIds.length === 0) {
		return {
			ok: true,
			workspacePath: workspaceRepoPath,
			column: target.kind === "column" ? target.column : null,
			deletedTasks: [],
			count: 0,
		};
	}
	await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => {
			try {
				await deleteTaskHistory(workspaceId, taskId);
			} catch (error) {
				warnAgentScoreRecording(`Could not delete task history for ${taskId}.`, error);
			}
		}),
	);

	await Promise.all(
		mutation.value.taskIdsRequiringStop.map(async (taskId) => await stopTaskRuntimeSession(runtimeClient, taskId)),
	);

	const workspaceCleanupResults = await Promise.all(
		mutation.value.deletedTaskIds.map(async (taskId) => ({
			taskId,
			...(await deleteTaskWorkspace(runtimeClient, taskId)),
		})),
	);

	return {
		ok: true,
		workspacePath: workspaceRepoPath,
		column: target.kind === "column" ? target.column : null,
		deletedTasks: mutation.value.deletedTasks,
		count: mutation.value.deletedTaskIds.length,
		worktreeCleanup: workspaceCleanupResults,
	};
}

function parseOptionalBooleanOption(value: unknown, flagName: string): boolean | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === true || value === false) {
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid boolean value for ${flagName}. Use true or false.`);
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	throw new Error(`Invalid boolean value for ${flagName}: "${value}". Use true or false.`);
}

async function runTaskCommand(handler: () => Promise<JsonRecord>, print = printJson): Promise<void> {
	try {
		print(await handler());
	} catch (error) {
		printJson({
			ok: false,
			error: `Task command failed at ${getKanbanRuntimeOrigin()}: ${toErrorMessage(error)}`,
		});
		process.exitCode = 1;
	}
}

export function registerTaskCommand(program: Command): void {
	const task = program.command("task").alias("tasks").description("Manage Kanban board tasks from the CLI.");

	task
		.command("list")
		.description("List Kanban tasks for a workspace.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option(
			"--column <column>",
			"Filter column: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--all", "Show every Done task.")
		.option("--json", "Print compact JSON.")
		.option("--full", "Print the full task records as JSON.")
		.action(
			async (options: {
				projectPath?: string;
				column?: ListTaskColumn;
				all?: boolean;
				json?: boolean;
				full?: boolean;
			}) => {
				await runTaskCommand(async () => {
					const result = await listTasks({
						cwd: process.cwd(),
						projectPath: options.projectPath,
						column: options.column,
						all: options.all,
					});
					if (options.full) return result.full;
					if (options.json) return compactTaskListJson(result.compact);
					return { text: formatTaskListText(result.compact) };
				}, printTextOrJson);
			},
		);

	task
		.command("models")
		.description("Show each agent's difficulty table, available models, and review pass/fail counts.")
		.option("--agent <id>", "Only this agent: codex | opencode | claude.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { agent?: string; projectPath?: string }) => {
			await runTaskCommand(
				() => listTaskModels({ cwd: process.cwd(), projectPath: options.projectPath, agent: options.agent }),
				printTextOrJson,
			);
		});

	task
		.command("show")
		.description("Show the full record for one task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; projectPath?: string }) => {
			await runTaskCommand(() =>
				showTask({ cwd: process.cwd(), projectPath: options.projectPath, taskId: options.taskId }),
			);
		});

	task
		.command("comment")
		.description("Add a short comment to a task for the next agent.")
		.requiredOption("--message <text>", "Comment text.")
		.option("--task-id <id>", "Task ID. Defaults to KANBAN_HOOK_TASK_ID in a task session.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; projectPath?: string; message: string }) => {
			await runTaskCommand(() =>
				commentOnTask({
					cwd: process.cwd(),
					taskId: options.taskId,
					projectPath: options.projectPath,
					message: options.message,
				}),
			);
		});

	task
		.command("create")
		.description("Create a task in backlog.")
		.option("--title <text>", "Task title.")
		.requiredOption("--prompt <text>", "Task prompt text.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Task base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--agent-review-enabled [value]", "Enable agent review (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option("--agent-id <id>", `Agent override: ${VALID_AGENT_IDS_TEXT} | default.`)
		.option("--model <model>", "Model: haiku | sonnet | opus for claude, a model id for codex or opencode.")
		.option("--reasoning-effort <level>", "Codex reasoning effort.")
		.option("--difficulty <1-5>", "Task difficulty, from 1 (one-file change) to 5 (multi-layer change).")
		.option("--summary <text>", "Short summary for the GitHub issue body when issue sync is on.")
		.option("--labels <a,b>", "Comma-separated GitHub issue labels (must already exist on the repo).")
		.option("--milestone <name>", "GitHub issue milestone (must already exist on the repo).")
		.option("--assignee <login>", "GitHub issue assignee. Defaults to @me on create.")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" for workspace default.',
		)
		.option(
			"--cline-model <id>",
			'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" for workspace default.',
		)
		.option(
			"--cline-reasoning-effort <level>",
			"Cline reasoning effort override: default | low | medium | high | xhigh.",
		)
		.action(
			async (options: {
				title?: string;
				prompt: string;
				summary?: string;
				labels?: string;
				milestone?: string;
				assignee?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				agentReviewEnabled?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				model?: string;
				reasoningEffort?: string;
				difficulty?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await createTask({
							cwd: process.cwd(),
							title: options.title,
							prompt: options.prompt,
							projectPath: options.projectPath,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							agentReviewEnabled: parseOptionalBooleanOption(
								options.agentReviewEnabled,
								"--agent-review-enabled",
							),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId) ?? undefined,
							model: options.model,
							reasoningEffort: options.reasoningEffort,
							difficulty: options.difficulty,
							summary: options.summary,
							issueMetadata: parseTaskIssueMetadata(options),
							clineSettings: buildTaskClineSettingsForCreate({
								providerId: parseOptionalStringOrDefault(options.clineProvider) ?? undefined,
								modelId: parseOptionalStringOrDefault(options.clineModel) ?? undefined,
								reasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
							}),
						}),
				);
			},
		);

	task
		.command("update")
		.description("Update an existing task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--title <text>", "Replacement task title.")
		.option("--summary <text>", "Replacement GitHub issue body summary.")
		.option("--labels <a,b>", "Comma-separated GitHub issue labels (must already exist on the repo).")
		.option("--milestone <name>", "GitHub issue milestone (must already exist on the repo).")
		.option("--assignee <login>", "GitHub issue assignee.")
		.option("--prompt <text>", "Replacement task prompt.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--base-ref <branch>", "Replacement base branch/ref.")
		.option("--start-in-plan-mode [value]", "Set plan mode (true|false). Flag-only implies true.")
		.option("--agent-review-enabled [value]", "Enable agent review (true|false). Flag-only implies true.")
		.option("--auto-review-enabled [value]", "Enable auto-review behavior (true|false). Flag-only implies true.")
		.option("--auto-review-mode <mode>", "Auto-review mode: commit | pr.", parseAutoReviewMode)
		.option("--agent-id <id>", `Agent override: ${VALID_AGENT_IDS_TEXT}. Use "default" to clear.`)
		.option(
			"--model <model>",
			'Model: haiku | sonnet | opus for claude, a model id for codex or opencode. Use "default" to clear.',
		)
		.option("--reasoning-effort <level>", 'Codex reasoning effort. Use "default" to clear.')
		.option("--difficulty <1-5>", "Task difficulty, from 1 (one-file change) to 5 (multi-layer change).")
		.option(
			"--cline-provider <id>",
			'Cline provider override (e.g. anthropic, openai, cline). Use "default" to clear.',
		)
		.option("--cline-model <id>", 'Cline model override (e.g. claude-sonnet-4-20250514). Use "default" to clear.')
		.option(
			"--cline-reasoning-effort <level>",
			'Cline reasoning effort override: default | low | medium | high | xhigh. Use "inherit" to clear.',
		)
		.action(
			async (options: {
				taskId: string;
				title?: string;
				summary?: string;
				labels?: string;
				milestone?: string;
				assignee?: string;
				prompt?: string;
				projectPath?: string;
				baseRef?: string;
				startInPlanMode?: unknown;
				agentReviewEnabled?: unknown;
				autoReviewEnabled?: unknown;
				autoReviewMode?: "commit" | "pr";
				agentId?: string;
				model?: string;
				reasoningEffort?: string;
				difficulty?: string;
				clineProvider?: string;
				clineModel?: string;
				clineReasoningEffort?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await updateTaskCommand({
							cwd: process.cwd(),
							taskId: options.taskId,
							title: options.title,
							summary: options.summary,
							issueMetadata: parseTaskIssueMetadata(options),
							projectPath: options.projectPath,
							prompt: options.prompt,
							baseRef: options.baseRef,
							startInPlanMode: parseOptionalBooleanOption(options.startInPlanMode, "--start-in-plan-mode"),
							agentReviewEnabled: parseOptionalBooleanOption(
								options.agentReviewEnabled,
								"--agent-review-enabled",
							),
							autoReviewEnabled: parseOptionalBooleanOption(options.autoReviewEnabled, "--auto-review-enabled"),
							autoReviewMode: options.autoReviewMode,
							agentId: parseAgentId(options.agentId),
							model: options.model,
							reasoningEffort: options.reasoningEffort,
							difficulty: options.difficulty,
							clineProviderId: parseOptionalStringOrDefault(options.clineProvider),
							clineModelId: parseOptionalStringOrDefault(options.clineModel),
							clineReasoningEffort: parseTaskClineReasoningEffort(options.clineReasoningEffort),
						}),
				);
			},
		);

	task
		.command("trash")
		.alias("done")
		.description("Move a task or an entire column to done and clean up task workspaces.")
		.option("--task-id <id>", "Task ID.")
		.option(
			"--column <column>",
			"Column to move to done: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.option("--review-passed", "Record a passed agent review before moving the task to done.")
		.option("--commit <hash>", "Cherry-picked commit hash on the base branch for a passed review.")
		.action(
			async (options: {
				taskId?: string;
				column?: ListTaskColumn;
				projectPath?: string;
				reviewPassed?: boolean;
				commit?: string;
			}) => {
				await runTaskCommand(
					async () =>
						await trashTask({
							cwd: process.cwd(),
							taskId: options.taskId,
							column: options.column,
							projectPath: options.projectPath,
							reviewPassed: options.reviewPassed,
							commit: options.commit,
						}),
				);
			},
		);

	task
		.command("issue-review")
		.description("Store a sidebar review for the runtime to post to GitHub.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--status <approved|changes-requested>", "Review result.")
		.option("--body <text>", "Review sections 1–5 plus Status and Next Action.")
		.option("--file <path>", "Read the review body from a UTF-8 file.")
		.option("--reviewer <name>", "Reviewer agent. Defaults to the runtime's selected home agent.")
		.option("--reviewer-model <id>", "Reviewer's own model ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(
			async (options: {
				taskId: string;
				status: string;
				body?: string;
				file?: string;
				reviewer?: string;
				reviewerModel?: string;
				projectPath?: string;
			}) => {
				await runTaskCommand(async () => {
					if ((options.body === undefined) === (options.file === undefined))
						throw new Error("task issue-review requires exactly one of --file or --body.");
					if (options.status !== "approved" && options.status !== "changes-requested")
						throw new Error("Invalid review status. Expected approved or changes-requested.");
					const input = runtimeAddTaskIssueReviewRequestSchema.parse({
						...options,
						status: options.status === "approved" ? "pass" : "fail",
						body: options.file === undefined ? options.body : await readFile(options.file, "utf8"),
					});
					const repoPath = await resolveWorkspaceRepoPath(options.projectPath, process.cwd());
					const workspaceId = await ensureRuntimeWorkspace(repoPath);
					return await createRuntimeTrpcClient(workspaceId).workspace.addTaskIssueReview.mutate(input);
				});
			},
		);

	task
		.command("review-failed")
		.description("Record a failed agent review for a task.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--message <text>", "Failure reason or fix list.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; message?: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await reviewFailed({
						cwd: process.cwd(),
						taskId: options.taskId,
						message: options.message,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("delete")
		.description("Permanently delete a task or every task in a column.")
		.option("--task-id <id>", "Task ID to permanently delete.")
		.option(
			"--column <column>",
			"Column to bulk-delete: backlog | in_progress | review | done. trash is also accepted.",
			parseListColumn,
		)
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId?: string; column?: ListTaskColumn; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await deleteTaskCommand({
						cwd: process.cwd(),
						taskId: options.taskId,
						column: options.column,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("link")
		.description("Link two tasks so one task waits on another.")
		.requiredOption("--task-id <id>", "One of the two task IDs to link.")
		.requiredOption("--linked-task-id <id>", "The other task ID to link.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.addHelpText(
			"after",
			[
				"",
				"Dependency direction:",
				"  If both linked tasks are in backlog, Kanban preserves the order you pass:",
				"  --task-id waits on --linked-task-id, and on the board the arrow points into",
				"  --linked-task-id.",
				"  Once only one linked task remains in backlog, Kanban reorients the saved link",
				"  so the backlog task is the waiting dependent task and the other task is the",
				"  prerequisite.",
				"  When the prerequisite finishes review and moves to done, the waiting backlog",
				"  task becomes ready to start.",
				"",
			].join("\n"),
		)
		.action(async (options: { taskId: string; linkedTaskId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await linkTasks({
						cwd: process.cwd(),
						taskId: options.taskId,
						linkedTaskId: options.linkedTaskId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("unlink")
		.description("Remove an existing dependency link.")
		.requiredOption("--dependency-id <id>", "Dependency ID.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { dependencyId: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await unlinkTasks({
						cwd: process.cwd(),
						dependencyId: options.dependencyId,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("start")
		.description("Start or restart a task session and move task to in_progress.")
		.requiredOption("--task-id <id>", "Task ID.")
		.option("--message <text>", "Additional prompt text for the task session.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; message?: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await startTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						message: options.message,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("send")
		.description("Send a prompt to a running task session.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--message <text>", "Prompt text to send.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; message: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await sendTaskMessage({
						cwd: process.cwd(),
						taskId: options.taskId,
						message: options.message,
						projectPath: options.projectPath,
					}),
			);
		});

	task
		.command("handoff")
		.description("Hand off a task to the other supported agent.")
		.requiredOption("--task-id <id>", "Task ID.")
		.requiredOption("--message <text>", "Reason for handing off the task.")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (options: { taskId: string; message: string; projectPath?: string }) => {
			await runTaskCommand(
				async () =>
					await handOffTask({
						cwd: process.cwd(),
						taskId: options.taskId,
						message: options.message,
						projectPath: options.projectPath,
					}),
			);
		});
}
