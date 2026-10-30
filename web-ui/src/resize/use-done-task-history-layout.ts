import { useCallback, useMemo, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampBetween, clampWidthToContainer } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";

export const MIN_DONE_HISTORY_TASK_PANEL_WIDTH = 220;
export const MIN_DONE_HISTORY_RIGHT_PANEL_WIDTH = 400;
export const MIN_DONE_HISTORY_TRANSCRIPT_WIDTH = 360;

const TASK_PANEL_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DoneHistoryTaskPanelWidth,
	defaultValue: 320,
	normalize: (value) => Math.max(MIN_DONE_HISTORY_TASK_PANEL_WIDTH, Math.round(value)),
};

const TIMELINE_RATIO_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DoneHistoryTimelineRatio,
	defaultValue: 0.4,
	normalize: (value) => clampBetween(value, 0.15, 0.8),
};

const TRANSCRIPT_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.DoneHistoryTranscriptWidth,
	defaultValue: 500,
	normalize: (value) => Math.max(MIN_DONE_HISTORY_TRANSCRIPT_WIDTH, Math.round(value)),
};

export function clampDoneHistoryTaskPanelWidth(width: number, containerWidth: number): number {
	return clampWidthToContainer({
		width,
		minWidth: MIN_DONE_HISTORY_TASK_PANEL_WIDTH,
		containerWidth,
		reservedWidth: MIN_DONE_HISTORY_RIGHT_PANEL_WIDTH + 1,
	});
}

export function clampDoneHistoryTimelineRatio(ratio: number): number {
	return clampBetween(ratio, 0.15, 0.8);
}

export function clampDoneHistoryTranscriptWidth(width: number, containerWidth: number): number {
	return clampBetween(
		width,
		MIN_DONE_HISTORY_TRANSCRIPT_WIDTH,
		Math.max(MIN_DONE_HISTORY_TRANSCRIPT_WIDTH, containerWidth * 0.8),
		true,
	);
}

export function useDoneTaskHistoryLayout({
	containerWidth,
	containerHeight,
}: {
	containerWidth: number;
	containerHeight: number;
}): {
	displayTaskPanelWidth: number;
	displayTimelineHeight: number;
	displayTranscriptWidth: number;
	setTaskPanelWidth: (width: number) => void;
	setTimelineRatio: (ratio: number) => void;
	setTranscriptWidth: (width: number) => void;
	taskPanelWidth: number;
	timelineRatio: number;
	transcriptWidth: number;
} {
	const [taskPanelWidth, setTaskPanelWidthState] = useState(() => loadResizePreference(TASK_PANEL_WIDTH_PREFERENCE));
	const [timelineRatio, setTimelineRatioState] = useState(() => loadResizePreference(TIMELINE_RATIO_PREFERENCE));
	const [transcriptWidth, setTranscriptWidthState] = useState(() => loadResizePreference(TRANSCRIPT_WIDTH_PREFERENCE));

	const setTaskPanelWidth = useCallback((width: number) => {
		setTaskPanelWidthState(persistResizePreference(TASK_PANEL_WIDTH_PREFERENCE, width));
	}, []);
	const setTimelineRatio = useCallback((ratio: number) => {
		setTimelineRatioState(persistResizePreference(TIMELINE_RATIO_PREFERENCE, ratio));
	}, []);
	const setTranscriptWidth = useCallback((width: number) => {
		setTranscriptWidthState(persistResizePreference(TRANSCRIPT_WIDTH_PREFERENCE, width));
	}, []);

	useLayoutResetEffect(() => {
		setTaskPanelWidthState(getResizePreferenceDefaultValue(TASK_PANEL_WIDTH_PREFERENCE));
		setTimelineRatioState(getResizePreferenceDefaultValue(TIMELINE_RATIO_PREFERENCE));
		setTranscriptWidthState(getResizePreferenceDefaultValue(TRANSCRIPT_WIDTH_PREFERENCE));
	});

	const displayTaskPanelWidth = useMemo(
		() => clampDoneHistoryTaskPanelWidth(taskPanelWidth, containerWidth),
		[containerWidth, taskPanelWidth],
	);
	const displayTimelineHeight = Math.round(containerHeight * clampDoneHistoryTimelineRatio(timelineRatio));
	const displayTranscriptWidth = useMemo(
		() => clampDoneHistoryTranscriptWidth(transcriptWidth, containerWidth),
		[containerWidth, transcriptWidth],
	);

	return {
		taskPanelWidth,
		timelineRatio,
		transcriptWidth,
		displayTaskPanelWidth,
		displayTimelineHeight,
		displayTranscriptWidth,
		setTaskPanelWidth,
		setTimelineRatio,
		setTranscriptWidth,
	};
}
