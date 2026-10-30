import { describe, expect, it } from "vitest";

import {
	clampDoneHistoryTaskPanelWidth,
	clampDoneHistoryTimelineRatio,
	clampDoneHistoryTranscriptWidth,
} from "@/resize/use-done-task-history-layout";
import { LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS, LocalStorageKey } from "@/storage/local-storage-store";

describe("done task history layout clamps", () => {
	it("keeps the task panel at least 220px and leaves 400px for history", () => {
		expect(clampDoneHistoryTaskPanelWidth(100, 1000)).toBe(220);
		expect(clampDoneHistoryTaskPanelWidth(900, 1000)).toBe(599);
	});

	it("clamps timeline ratio to 15–80 percent", () => {
		expect(clampDoneHistoryTimelineRatio(0.01)).toBe(0.15);
		expect(clampDoneHistoryTimelineRatio(0.4)).toBe(0.4);
		expect(clampDoneHistoryTimelineRatio(0.99)).toBe(0.8);
	});

	it("keeps transcript between 360px and 80 percent of the view", () => {
		expect(clampDoneHistoryTranscriptWidth(100, 1000)).toBe(360);
		expect(clampDoneHistoryTranscriptWidth(900, 1000)).toBe(800);
	});

	it("resets all three preferences with layout customization", () => {
		expect(LAYOUT_CUSTOMIZATION_LOCAL_STORAGE_KEYS).toEqual(
			expect.arrayContaining([
				LocalStorageKey.DoneHistoryTaskPanelWidth,
				LocalStorageKey.DoneHistoryTimelineRatio,
				LocalStorageKey.DoneHistoryTranscriptWidth,
			]),
		);
	});
});
