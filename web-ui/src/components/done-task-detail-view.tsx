import { RUNTIME_AGENT_CATALOG } from "@runtime-agent-catalog";
import { Clock, History, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { type DiffLineComment, DiffViewerPanel } from "@/components/detail-panels/diff-viewer-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ResizeHandle } from "@/resize/resize-handle";
import { useDoneTaskHistoryLayout } from "@/resize/use-done-task-history-layout";
import { useResizeDrag } from "@/resize/use-resize-drag";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeAgentTranscriptResponse,
	RuntimeCommitChangesResponse,
	RuntimeTaskHistoryEvent,
	RuntimeTaskPatchChangesResponse,
	RuntimeWorkspaceFileChange,
} from "@/runtime/types";
import type { CardSelection } from "@/types";
import { useMeasure, useWindowEvent } from "@/utils/react-use";

export interface DoneTaskDetailViewProps {
	selection: CardSelection;
	currentProjectId: string | null;
}

type RuntimeAgentTranscriptTurn = Extract<RuntimeAgentTranscriptResponse, { turns: unknown[] }>["turns"][number];

interface HistoryRun {
	agentId: string;
	sessionEvent?: RuntimeTaskHistoryEvent;
	events: RuntimeTaskHistoryEvent[];
}

function getAgentDisplayName(agentId: string): string {
	const entry = RUNTIME_AGENT_CATALOG.find((e) => e.id === agentId);
	return entry?.label ?? agentId;
}

function formatEventTime(timestamp: number): string {
	if (!timestamp || Number.isNaN(timestamp)) {
		return "";
	}
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function groupEventsIntoRuns(events: RuntimeTaskHistoryEvent[]): HistoryRun[] {
	const runs: HistoryRun[] = [];
	let currentRun: HistoryRun | null = null;

	for (const event of events) {
		if (event.type === "session") {
			if (currentRun && !currentRun.sessionEvent && currentRun.agentId === event.agentId) {
				currentRun.sessionEvent = event;
			} else {
				currentRun = {
					agentId: event.agentId,
					sessionEvent: event,
					events: [],
				};
				runs.push(currentRun);
			}
			continue;
		}

		const shouldStartNewRun =
			!currentRun ||
			(event.type === "started" && currentRun.events.length > 0) ||
			(currentRun.events.length > 0 && currentRun.agentId !== event.agentId);

		if (shouldStartNewRun || !currentRun) {
			currentRun = {
				agentId: event.agentId,
				events: [event],
			};
			runs.push(currentRun);
		} else {
			if (currentRun.events.length === 0) {
				currentRun.agentId = event.agentId;
			}
			currentRun.events.push(event);
		}
	}

	return runs;
}

function getEventDisplayInfo(event: RuntimeTaskHistoryEvent): {
	label: string;
	colorClassName: string;
} {
	switch (event.type) {
		case "started":
			return {
				label: "Started",
				colorClassName: "text-text-secondary",
			};
		case "fail":
			return {
				label: event.round ? `Review ${event.round} failed` : "Review failed",
				colorClassName: "text-status-red",
			};
		case "handoff": {
			const toAgentLabel = event.toAgentId ? getAgentDisplayName(event.toAgentId) : "another agent";
			return {
				label: `Handed off to ${toAgentLabel}`,
				colorClassName: "text-status-orange",
			};
		}
		case "quota_blocked":
			return {
				label: "Out of quota",
				colorClassName: "text-status-orange",
			};
		case "retry": {
			const toAgent = event.toAgentId ?? event.agentId;
			const toAgentLabel = getAgentDisplayName(toAgent);
			return {
				label: `Retried with ${toAgentLabel}`,
				colorClassName: "text-status-orange",
			};
		}
		case "pass": {
			return {
				label: event.commit ? `Passed · ${event.commit}` : "Passed",
				colorClassName: "text-status-green",
			};
		}
		default:
			return {
				label: event.type,
				colorClassName: "text-text-secondary",
			};
	}
}

export function DoneTaskDetailView({ selection, currentProjectId }: DoneTaskDetailViewProps): React.ReactElement {
	const { card } = selection;
	const [historyEvents, setHistoryEvents] = useState<RuntimeTaskHistoryEvent[] | null>(null);
	const [isHistoryLoading, setIsHistoryLoading] = useState(true);

	const [commitChanges, setCommitChanges] = useState<RuntimeCommitChangesResponse | null>(null);
	const [patchChanges, setPatchChanges] = useState<RuntimeTaskPatchChangesResponse | null>(null);
	const [isCommitLoading, setIsCommitLoading] = useState(false);
	const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
	const emptyComments = useMemo(() => new Map<string, DiffLineComment>(), []);
	const noopCommentsChange = useCallback(() => {}, []);

	const [expandedDetailKeys, setExpandedDetailKeys] = useState<Set<string>>(() => new Set());
	const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
	const [transcriptResult, setTranscriptResult] = useState<RuntimeAgentTranscriptResponse | null>(null);
	const [isTranscriptLoading, setIsTranscriptLoading] = useState(false);
	const [transcriptTurns, setTranscriptTurns] = useState<RuntimeAgentTranscriptTurn[]>([]);
	const [isTranscriptTruncated, setIsTranscriptTruncated] = useState(false);
	const [expandedInstructionTurns, setExpandedInstructionTurns] = useState<Set<number>>(() => new Set());
	const [layoutRef, layoutRect] = useMeasure<HTMLDivElement>();
	const { startDrag: startResizeDrag } = useResizeDrag();
	const {
		timelineRatio,
		displayTaskPanelWidth,
		displayTimelineHeight,
		displayTranscriptWidth,
		setTaskPanelWidth,
		setTimelineRatio,
		setTranscriptWidth,
	} = useDoneTaskHistoryLayout({ containerWidth: layoutRect.width, containerHeight: layoutRect.height });
	const layoutHeight = Math.max(layoutRect.height, 1);
	const handleTaskPanelResize = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const startX = event.clientX;
			startResizeDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => setTaskPanelWidth(displayTaskPanelWidth + pointerX - startX),
			});
		},
		[displayTaskPanelWidth, setTaskPanelWidth, startResizeDrag],
	);
	const handleTimelineResize = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const startY = event.clientY;
			startResizeDrag(event, {
				axis: "y",
				cursor: "ns-resize",
				onMove: (pointerY) => setTimelineRatio(timelineRatio + (pointerY - startY) / layoutHeight),
			});
		},
		[layoutHeight, setTimelineRatio, startResizeDrag, timelineRatio],
	);
	const handleTranscriptResize = useCallback(
		(event: ReactMouseEvent<HTMLDivElement>) => {
			const startX = event.clientX;
			startResizeDrag(event, {
				axis: "x",
				cursor: "ew-resize",
				onMove: (pointerX) => setTranscriptWidth(displayTranscriptWidth + startX - pointerX),
			});
		},
		[displayTranscriptWidth, setTranscriptWidth, startResizeDrag],
	);
	const handleTranscriptKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (viewingSessionId && event.key === "Escape") {
				setViewingSessionId(null);
			}
		},
		[viewingSessionId],
	);
	useWindowEvent("keydown", viewingSessionId ? handleTranscriptKeyDown : null);

	// Load history
	useEffect(() => {
		let isCancelled = false;
		setIsHistoryLoading(true);
		const trpcClient = getRuntimeTrpcClient(currentProjectId);

		trpcClient.workspace.getTaskHistory
			.query({ taskId: card.id })
			.then((response) => {
				if (!isCancelled) {
					setHistoryEvents(response.events);
					setIsHistoryLoading(false);
				}
			})
			.catch(() => {
				if (!isCancelled) {
					setHistoryEvents([]);
					setIsHistoryLoading(false);
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [card.id, currentProjectId]);

	// Load pass commit diff
	const passEvent = useMemo(() => {
		return historyEvents?.find((event) => event.type === "pass");
	}, [historyEvents]);

	useEffect(() => {
		let isCancelled = false;
		setCommitChanges(null);
		setPatchChanges(null);
		setIsCommitLoading(true);
		if (isHistoryLoading) {
			return () => {
				isCancelled = true;
			};
		}
		const trpcClient = getRuntimeTrpcClient(currentProjectId);
		const loadPatch = async () => {
			const response = await trpcClient.workspace.getTaskPatchChanges
				.query({ taskId: card.id })
				.catch(() => ({ notFound: true as const }));
			if (!isCancelled) setPatchChanges(response);
		};
		void (async () => {
			if (!passEvent?.commit) {
				await loadPatch();
			} else {
				const response = await trpcClient.workspace.getCommitChanges
					.query({ commit: passEvent.commit })
					.catch(() => ({ notFound: true as const, commit: passEvent.commit! }));
				if (!isCancelled) setCommitChanges(response);
				if ("notFound" in response) await loadPatch();
			}
			if (!isCancelled) setIsCommitLoading(false);
		})();

		return () => {
			isCancelled = true;
		};
	}, [card.id, currentProjectId, isHistoryLoading, passEvent?.commit]);

	// Load transcript when viewingSessionId changes
	const handleOpenSessionTranscript = useCallback((sessionId: string) => {
		setViewingSessionId(sessionId);
	}, []);

	useEffect(() => {
		if (!viewingSessionId) {
			setTranscriptResult(null);
			setTranscriptTurns([]);
			setIsTranscriptTruncated(false);
			return;
		}

		let isCancelled = false;
		setIsTranscriptLoading(true);
		const trpcClient = getRuntimeTrpcClient(currentProjectId);

		trpcClient.workspace.getAgentTranscript
			.query({ taskId: card.id, sessionId: viewingSessionId })
			.then((response) => {
				if (!isCancelled) {
					setTranscriptResult(response);
					if ("turns" in response) {
						setTranscriptTurns(response.turns);
						setIsTranscriptTruncated(response.truncated);
					} else {
						setTranscriptTurns([]);
						setIsTranscriptTruncated(false);
					}
					setIsTranscriptLoading(false);
				}
			})
			.catch((error: unknown) => {
				if (!isCancelled) {
					const reason = error instanceof Error ? error.message : "failed to load";
					setTranscriptResult({ unavailable: reason });
					setTranscriptTurns([]);
					setIsTranscriptTruncated(false);
					setIsTranscriptLoading(false);
				}
			});

		return () => {
			isCancelled = true;
		};
	}, [card.id, currentProjectId, viewingSessionId]);

	const handleLoadEarlierTurns = useCallback(async () => {
		if (!viewingSessionId || transcriptTurns.length === 0) {
			return;
		}
		const earliestTurnAt = transcriptTurns[0]?.at;
		if (earliestTurnAt === undefined) {
			return;
		}

		const trpcClient = getRuntimeTrpcClient(currentProjectId);
		try {
			const response = await trpcClient.workspace.getAgentTranscript.query({
				taskId: card.id,
				sessionId: viewingSessionId,
				before: earliestTurnAt,
			});
			if ("turns" in response) {
				setTranscriptTurns((current) => [...response.turns, ...current]);
				setIsTranscriptTruncated(response.truncated);
			}
		} catch {
			// keep current turns on error
		}
	}, [card.id, currentProjectId, transcriptTurns, viewingSessionId]);

	const toggleDetailExpand = useCallback((key: string) => {
		setExpandedDetailKeys((current) => {
			const next = new Set(current);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const runs = useMemo(() => {
		if (!historyEvents || historyEvents.length === 0) {
			return [];
		}
		return groupEventsIntoRuns(historyEvents);
	}, [historyEvents]);

	const workspaceFiles: RuntimeWorkspaceFileChange[] | null = useMemo(() => {
		if (!commitChanges || !("files" in commitChanges)) {
			return null;
		}
		return commitChanges.files;
	}, [commitChanges]);

	return (
		<div className="relative flex h-full w-full flex-col bg-surface-0 text-text-primary overflow-hidden">
			{/* Main Content: Left Column + Right Column */}
			<div ref={layoutRef} className="relative flex flex-1 min-h-0 overflow-hidden">
				{/* Left: Task Title & Prompt */}
				<aside
					className="flex shrink-0 flex-col bg-surface-0 overflow-y-auto p-4"
					style={{ width: displayTaskPanelWidth }}
				>
					<div className="space-y-4">
						<div>
							<div className="flex items-center justify-between gap-2">
								<span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">Task</span>
								<span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-secondary">
									Read-only history
								</span>
							</div>
							<h1 className="mt-1 text-base font-semibold text-text-primary break-words">{card.title}</h1>
						</div>

						{card.prompt && (
							<div>
								<span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
									Prompt
								</span>
								<div className="mt-1.5 p-3 text-sm text-text-secondary whitespace-pre-wrap break-words">
									{card.prompt}
								</div>
							</div>
						)}
					</div>
				</aside>
				<ResizeHandle
					orientation="vertical"
					ariaLabel="Resize task and history panels"
					onMouseDown={handleTaskPanelResize}
				/>

				{/* Right: Top Timeline + Bottom Diff */}
				<main className="flex flex-1 flex-col min-h-0 min-w-0 overflow-hidden">
					{/* Right Top: Timeline */}
					<div
						className="flex shrink-0 flex-col min-h-0 overflow-y-auto p-4"
						style={{ height: displayTimelineHeight }}
					>
						<div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
							<History size={14} />
							<span>Timeline</span>
						</div>

						{isHistoryLoading ? (
							<div className="flex flex-1 items-center justify-center p-8">
								<Spinner size={20} />
							</div>
						) : !historyEvents || historyEvents.length === 0 ? (
							<div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
								No history recorded for this task.
							</div>
						) : (
							<div className="space-y-6">
								{runs.map((run, runIndex) => {
									const agentLabel = getAgentDisplayName(run.agentId);
									const sessionRef = run.sessionEvent?.agentSession;

									return (
										<div
											key={`run-${run.agentId}-${runIndex}`}
											className="rounded-lg border border-border bg-surface-1 p-3"
										>
											{/* Run Header */}
											<div className="mb-3 flex items-center justify-between border-b border-border pb-2">
												<div className="flex items-center gap-2">
													<span className="font-semibold text-sm text-text-primary">{agentLabel}</span>
													{sessionRef?.id && (
														<span className="text-xs text-text-tertiary font-mono">{sessionRef.id}</span>
													)}
												</div>
												{sessionRef?.id && (
													<Button
														variant="ghost"
														size="sm"
														onClick={() => handleOpenSessionTranscript(sessionRef.id!)}
													>
														View agent session
													</Button>
												)}
											</div>

											{/* Run Events */}
											<div className="space-y-3">
												{run.events.map((event, eventIndex) => {
													const eventKey = `${runIndex}-${eventIndex}-${event.at}-${event.type}`;
													const display = getEventDisplayInfo(event);
													const isExpanded = expandedDetailKeys.has(eventKey);

													return (
														<div key={eventKey} className="text-sm">
															<div className="flex items-center gap-2.5">
																<span className="inline-flex items-center gap-1 text-xs text-text-tertiary font-mono">
																	<Clock size={12} />
																	{formatEventTime(event.at)}
																</span>
																<span className="font-medium text-xs text-text-secondary">
																	{getAgentDisplayName(event.agentId)}
																</span>
																<span className={`font-medium text-sm ${display.colorClassName}`}>
																	{display.label}
																</span>
															</div>

															{event.detail && (
																<div className="mt-1 pl-5">
																	<div
																		className={`text-xs text-text-secondary whitespace-pre-wrap font-mono ${
																			isExpanded ? "" : "line-clamp-3"
																		}`}
																	>
																		{event.detail}
																	</div>
																	<button
																		type="button"
																		className="mt-0.5 text-xs text-accent hover:underline cursor-pointer"
																		onClick={() => toggleDetailExpand(eventKey)}
																	>
																		{isExpanded ? "Show less" : "Show all"}
																	</button>
																</div>
															)}
														</div>
													);
												})}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
					<ResizeHandle
						orientation="horizontal"
						ariaLabel="Resize timeline and diff panels"
						onMouseDown={handleTimelineResize}
					/>

					{/* Right Bottom: Commit Diff */}
					<div className="flex flex-1 flex-col min-h-0 bg-surface-0">
						{isCommitLoading ? (
							<div className="flex flex-1 items-center justify-center p-8">
								<Spinner size={20} />
							</div>
						) : !passEvent?.commit ? (
							patchChanges && "files" in patchChanges ? (
								<>
									<div className="shrink-0 px-4 py-2 text-xs text-text-secondary">
										Uncommitted changes saved when the task was moved to Done
									</div>
									<DiffViewerPanel
										workspaceFiles={patchChanges.files}
										selectedPath={selectedDiffPath}
										onSelectedPathChange={setSelectedDiffPath}
										comments={emptyComments}
										onCommentsChange={noopCommentsChange}
										viewMode="unified"
									/>
								</>
							) : (
								<div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
									No commit recorded for this task.
								</div>
							)
						) : commitChanges && "notFound" in commitChanges ? (
							patchChanges && "files" in patchChanges ? (
								<>
									<div className="shrink-0 px-4 py-2 text-xs text-text-secondary">
										Uncommitted changes saved when the task was moved to Done
									</div>
									<DiffViewerPanel
										workspaceFiles={patchChanges.files}
										selectedPath={selectedDiffPath}
										onSelectedPathChange={setSelectedDiffPath}
										comments={emptyComments}
										onCommentsChange={noopCommentsChange}
										viewMode="unified"
									/>
								</>
							) : (
								<div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
									Commit {commitChanges.commit} not found on this repository.
								</div>
							)
						) : workspaceFiles ? (
							<DiffViewerPanel
								workspaceFiles={workspaceFiles}
								selectedPath={selectedDiffPath}
								onSelectedPathChange={setSelectedDiffPath}
								comments={emptyComments}
								onCommentsChange={noopCommentsChange}
								viewMode="unified"
							/>
						) : (
							<div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
								No commit recorded for this task.
							</div>
						)}
					</div>
				</main>

				{/* Transcript Slide-out Panel */}
				{viewingSessionId && (
					<>
						<button
							type="button"
							className="absolute inset-0 z-10 cursor-default bg-black/40"
							aria-label="Close transcript"
							onClick={() => setViewingSessionId(null)}
						/>
						<aside
							role="dialog"
							aria-modal="true"
							aria-label="Agent Transcript"
							className="absolute inset-y-0 right-0 z-20 flex flex-row border-l border-border bg-surface-1 shadow-2xl"
							style={{ width: displayTranscriptWidth }}
						>
							<ResizeHandle
								orientation="vertical"
								ariaLabel="Resize transcript panel"
								onMouseDown={handleTranscriptResize}
							/>
							<div className="flex min-w-0 flex-1 flex-col">
								<div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
									<div className="flex items-center gap-2">
										<span className="font-semibold text-sm text-text-primary">Agent Transcript</span>
										<span className="text-xs text-text-tertiary font-mono truncate max-w-[200px]">
											{viewingSessionId}
										</span>
									</div>
									<Button
										variant="ghost"
										size="sm"
										icon={<X size={16} />}
										onClick={() => setViewingSessionId(null)}
										aria-label="Close"
									/>
								</div>

								<div className="flex flex-1 flex-col min-h-0 overflow-y-auto p-4">
									{isTranscriptLoading ? (
										<div className="flex flex-1 items-center justify-center p-8">
											<Spinner size={20} />
										</div>
									) : transcriptResult && "unavailable" in transcriptResult ? (
										<div className="flex flex-1 items-center justify-center p-8 text-sm text-text-tertiary">
											Transcript not available ({transcriptResult.unavailable}).
										</div>
									) : (
										<div className="space-y-4">
											{isTranscriptTruncated && (
												<div className="flex justify-center pb-2">
													<Button variant="ghost" size="sm" onClick={handleLoadEarlierTurns}>
														Load earlier
													</Button>
												</div>
											)}

											{transcriptTurns.map((turn, index) => {
												const isInjectedInstructions =
													turn.text.startsWith("# AGENTS.md instructions") ||
													turn.text.includes("<INSTRUCTIONS>");
												const isInstructionExpanded = expandedInstructionTurns.has(index);
												const roleBadgeColor =
													turn.role === "user"
														? "border-status-blue/30 bg-status-blue/10 text-status-blue"
														: turn.role === "assistant"
															? "border-status-green/30 bg-status-green/10 text-status-green"
															: "border-status-purple/30 bg-status-purple/10 text-status-purple";

												return (
													<div
														key={`turn-${index}-${turn.at ?? index}`}
														className="rounded-md border border-border bg-surface-2 p-3"
													>
														<div className="mb-1.5 flex items-center justify-between">
															<span
																className={`rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wider border ${roleBadgeColor}`}
															>
																{turn.role}
															</span>
															{turn.at && (
																<span className="text-xs text-text-tertiary font-mono">
																	{formatEventTime(turn.at)}
																</span>
															)}
														</div>
														{isInjectedInstructions ? (
															<>
																<button
																	type="button"
																	className="text-xs text-accent hover:underline cursor-pointer"
																	onClick={() =>
																		setExpandedInstructionTurns((current) => {
																			const next = new Set(current);
																			if (next.has(index)) next.delete(index);
																			else next.add(index);
																			return next;
																		})
																	}
																>
																	Injected instructions ·{" "}
																	{isInstructionExpanded ? "Show less" : "Show"}
																</button>
																{isInstructionExpanded && (
																	<div className="mt-2 text-xs text-text-primary whitespace-pre-wrap font-mono break-words leading-relaxed">
																		{turn.text}
																	</div>
																)}
															</>
														) : (
															<div className="text-xs text-text-primary whitespace-pre-wrap font-mono break-words leading-relaxed">
																{turn.text}
															</div>
														)}
													</div>
												);
											})}
										</div>
									)}
								</div>
							</div>
						</aside>
					</>
				)}
			</div>
		</div>
	);
}
