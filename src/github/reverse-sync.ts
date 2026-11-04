import { z } from "zod";
import type { RuntimeBoardCard, RuntimeBoardColumnId, RuntimeBoardData } from "../core/api-contract";
import { moveTaskToColumn } from "../core/task-board-mutations";
import { recordTaskHistoryEvent } from "../state/task-history";
import { mutateWorkspaceState } from "../state/workspace-state";
import { KANBAN_SYNC_MARKER } from "./comment-format";
import type { GithubIssueEntry, GithubIssueMap } from "./issue-map";
import { sanitizeForGithub } from "./sanitize";

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const issueViewSchema = z.object({
	title: z.string(),
	body: z.string().nullable(),
	state: z.string(),
	comments: z.array(
		z.object({
			id: z.string(),
			body: z.string(),
			author: z.object({ login: z.string() }).nullish(),
			authorAssociation: z.string(),
		}),
	),
});
const issueListSchema = z.array(z.object({ number: z.number(), updatedAt: z.string() }));
export type GithubIssueSnapshot = z.infer<typeof issueViewSchema>;

export interface ReverseActions {
	updateSummary?: string;
	updateTitle?: string;
	moveToDone?: boolean;
	moveToBacklog?: boolean;
	recordClosedNotice?: boolean;
	recordComments: { login: string; body: string }[];
	lastCommentId?: string;
}

export const issueBody = (summary: string | undefined, taskId: string): string =>
	summary ? `${summary}\n\n---\nKanban task: ${taskId}` : `Kanban task: ${taskId}`;

const normalize = (text: string): string => text.replace(/\r\n/g, "\n").trim();
const stripFooter = (body: string): string =>
	normalize(body)
		.replace(/(?:\s*---\s*\n)?Kanban task: [^\n]*$/, "")
		.trim();

// Pure: what GitHub says versus what Kanban last wrote or saw. Never touches the board or gh.
export function decideReverseActions(
	entry: GithubIssueEntry,
	issue: GithubIssueSnapshot,
	card: RuntimeBoardCard,
	column: RuntimeBoardColumnId,
): ReverseActions {
	const actions: ReverseActions = { recordComments: [] };
	const body = issue.body ?? "";
	const knownBody = entry.syncedBody ?? sanitizeForGithub(issueBody(entry.syncedSummary, card.id));
	if (normalize(body) !== normalize(knownBody)) actions.updateSummary = stripFooter(body);
	if (entry.syncedTitle !== undefined && issue.title !== sanitizeForGithub(entry.syncedTitle))
		actions.updateTitle = issue.title;

	const closedOnGithub = issue.state.toUpperCase() === "CLOSED";
	if (closedOnGithub && !entry.closed) {
		if (column === "backlog") actions.moveToDone = true;
		else if (column !== "trash" && !entry.closedNoticed) actions.recordClosedNotice = true;
	} else if (!closedOnGithub && entry.closed && column === "trash") actions.moveToBacklog = true;

	const comments = issue.comments;
	const latest = comments.at(-1)?.id;
	// The first pull of an entry only sets a baseline ("" means none yet): comments that already exist
	// (including Kanban's own pre-marker ones posted from the owner's account) are never imported.
	if (entry.lastCommentId === undefined) {
		actions.lastCommentId = latest ?? "";
		return actions;
	}
	const seen = comments.findIndex((comment) => comment.id === entry.lastCommentId);
	// A last-seen comment that no longer exists (deleted) skips ahead instead of replaying everything.
	const fresh = entry.lastCommentId === "" ? comments : seen >= 0 ? comments.slice(seen + 1) : [];
	for (const comment of fresh)
		if (
			TRUSTED_ASSOCIATIONS.has(comment.authorAssociation) &&
			comment.author?.login &&
			!comment.body.includes(KANBAN_SYNC_MARKER)
		)
			actions.recordComments.push({ login: comment.author.login, body: comment.body });
	if (latest && latest !== entry.lastCommentId) actions.lastCommentId = latest;
	return actions;
}

export type BoardMutator = (
	repoPath: string,
	mutate: (board: RuntimeBoardData) => RuntimeBoardData | null,
) => Promise<boolean>;

// Goes through the locked workspace state path. `mutate` returns null to leave the board alone.
export const mutateBoardLocked: BoardMutator = async (repoPath, mutate) => {
	const { value } = await mutateWorkspaceState(repoPath, (state) => {
		const board = mutate(state.board);
		return { board: board ?? state.board, value: board !== null, save: board !== null };
	});
	return value;
};

const cardColumn = (board: RuntimeBoardData, taskId: string): RuntimeBoardColumnId | null =>
	board.columns.find((column) => column.cards.some((card) => card.id === taskId))?.id ?? null;

export interface PullGithubChangesInput {
	workspaceId: string;
	repoPath: string;
	board: RuntimeBoardData;
	map: GithubIssueMap;
	gh: (args: string[]) => Promise<{ stdout: string }>;
	mutateBoard: BoardMutator;
	save: () => Promise<void>;
	warn: (message: string) => void;
}
export interface PullGithubChangesResult {
	ok: boolean;
	error?: string;
	boardChanged: boolean;
	summaryChanged: boolean;
}

// Runs under the map lock before the push pass. GitHub wins for body and title. Skipped entries and
// entries without an issue are not read.
export async function pullGithubChanges(input: PullGithubChangesInput): Promise<PullGithubChangesResult> {
	const result: PullGithubChangesResult = { ok: true, boardChanged: false, summaryChanged: false };
	const hasIssues = Object.values(input.map).some((entry) => entry.issueNumber && !entry.skipped);
	if (!hasIssues) return result;
	// One list call per tick; only issues whose updatedAt moved since the last pull get a `gh issue view`.
	// ponytail: --limit 1000 covers 1000 issues; an issue past it is viewed every tick.
	let updatedAtByNumber: Map<number, string>;
	try {
		const listed = issueListSchema.parse(
			JSON.parse(
				(await input.gh(["issue", "list", "--state", "all", "--limit", "1000", "--json", "number,updatedAt"]))
					.stdout,
			),
		);
		updatedAtByNumber = new Map(listed.map((item) => [item.number, item.updatedAt]));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		input.warn(`[kanban] GitHub issue list failed: ${message}`);
		return { ...result, ok: false, error: message };
	}
	for (const boardColumn of input.board.columns)
		for (const card of boardColumn.cards) {
			const entry = input.map[card.id];
			if (!entry?.issueNumber || entry.skipped) continue;
			const updatedAt = updatedAtByNumber.get(entry.issueNumber);
			if (updatedAt !== undefined && updatedAt === entry.pulledUpdatedAt) continue;
			try {
				const issue = issueViewSchema.parse(
					JSON.parse(
						(await input.gh(["issue", "view", String(entry.issueNumber), "--json", "title,body,state,comments"]))
							.stdout,
					),
				);
				const actions = decideReverseActions(entry, issue, card, boardColumn.id);
				let next: GithubIssueEntry = { ...entry, pulledUpdatedAt: updatedAt };
				const apply = async (mutate: (board: RuntimeBoardData) => RuntimeBoardData | null) => {
					if (await input.mutateBoard(input.repoPath, mutate)) result.boardChanged = true;
				};
				if (actions.updateTitle !== undefined) {
					const title = actions.updateTitle;
					await apply((board) => ({
						...board,
						columns: board.columns.map((column) => ({
							...column,
							cards: column.cards.map((c) => (c.id === card.id ? { ...c, title, updatedAt: Date.now() } : c)),
						})),
					}));
					next.syncedTitle = title;
				}
				if (actions.updateSummary !== undefined) {
					result.summaryChanged = true;
					next = {
						...next,
						summary: actions.updateSummary,
						syncedSummary: actions.updateSummary,
						syncedBody: issue.body ?? "",
					};
				}
				// Only a Backlog card moves on close: Done stops sessions, removes the worktree, and auto-starts
				// linked tasks, and none of that should follow from a click on GitHub. Moving only the column
				// leaves dependents waiting.
				if (actions.moveToDone) {
					await apply((board) =>
						cardColumn(board, card.id) === "backlog" ? moveTaskToColumn(board, card.id, "trash").board : null,
					);
					next = { ...next, closed: true, syncedColumn: "trash", doneCommented: true };
				}
				if (actions.moveToBacklog) {
					await apply((board) =>
						cardColumn(board, card.id) === "trash" ? moveTaskToColumn(board, card.id, "backlog").board : null,
					);
					// syncedColumn is cleared so the push pass restores the status label on the reopened issue.
					next = { ...next, closed: false, syncedColumn: undefined, doneCommented: false, closedNoticed: false };
				}
				if (issue.state.toUpperCase() !== "CLOSED" && next.closedNoticed) next.closedNoticed = false;
				if (actions.recordClosedNotice) {
					await recordTaskHistoryEvent(input.workspaceId, card.id, {
						type: "comment",
						agentId: "kanban",
						detail: "Issue closed on GitHub. The task keeps running.",
					});
					next.closedNoticed = true;
				}
				for (const comment of actions.recordComments)
					await recordTaskHistoryEvent(input.workspaceId, card.id, {
						type: "comment",
						agentId: "github",
						detail: comment.body,
						source: "github",
						author: comment.login,
					});
				if (actions.lastCommentId !== undefined) next.lastCommentId = actions.lastCommentId;
				if (JSON.stringify(next) !== JSON.stringify(entry)) {
					input.map[card.id] = next;
					await input.save();
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				input.map[card.id] = { ...input.map[card.id], lastError: message };
				await input.save();
				result.ok = false;
				result.error ??= message;
				input.warn(`[kanban] GitHub issue pull failed for task ${card.id}: ${message}`);
			}
		}
	return result;
}
