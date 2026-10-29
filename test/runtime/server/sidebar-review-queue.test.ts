import { describe, expect, it } from "vitest";

import { createSidebarReviewQueue } from "../../../src/server/sidebar-review-queue";

describe("createSidebarReviewQueue", () => {
	it("ignores tasks with review off", () => {
		const queue = createSidebarReviewQueue();
		expect(queue.onTaskTurnEnd({ id: "a", title: "A" })).toBeNull();
		expect(queue.onSidebarIdle()).toBeNull();
	});

	it("queues round 1 and formats the wake-up line", () => {
		const queue = createSidebarReviewQueue();
		expect(queue.onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true, reviewRound: 0 })).toEqual({
			round: 1,
		});
		expect(queue.onSidebarIdle()).toBe('[Kanban review] Task a "A" is in Review, round 1/3. Review it now.');
	});

	it("never queues round 4", () => {
		const queue = createSidebarReviewQueue();
		expect(queue.onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true, reviewRound: 3 })).toBeNull();
	});

	it("allows two handoffs through round 9", () => {
		const queue = createSidebarReviewQueue();
		expect(
			queue.onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true, handOffCount: 1, reviewRound: 3 }),
		).toEqual({ round: 4 });
		expect(queue.onSidebarIdle()).toBe('[Kanban review] Task a "A" is in Review, round 4/6. Review it now.');
		expect(
			queue.onTaskTurnEnd({ id: "b", title: "B", agentReviewEnabled: true, handOffCount: 2, reviewRound: 8 }),
		).toEqual({ round: 9 });
		queue.onTaskDelivered(queue.onSidebarIdle() ?? "");
		expect(queue.onSidebarIdle()).toContain("round 9/9");
		expect(
			queue.onTaskTurnEnd({ id: "c", title: "C", agentReviewEnabled: true, handOffCount: 2, reviewRound: 9 }),
		).toBeNull();
		expect(queue.onTaskTurnEnd({ id: "c", title: "C", agentReviewEnabled: true, reviewRound: 3 })).toBeNull();
	});

	it("keeps one queued task until delivery and then advances", () => {
		const queue = createSidebarReviewQueue();
		queue.onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true });
		queue.onTaskTurnEnd({ id: "b", title: "B", agentReviewEnabled: true });
		const firstPrompt = queue.onSidebarIdle();
		expect(firstPrompt).toContain("Task a");
		expect(queue.onSidebarIdle()).toBe(firstPrompt);
		queue.onTaskDelivered(firstPrompt ?? "");
		expect(queue.onSidebarIdle()).toContain("Task b");
		queue.onTaskDelivered(queue.onSidebarIdle() ?? "");
		expect(queue.onSidebarIdle()).toBeNull();
	});

	it("done clears a queued task", () => {
		const queue = createSidebarReviewQueue();
		queue.onTaskTurnEnd({ id: "a", title: "A", agentReviewEnabled: true });
		queue.onTaskDone("a");
		expect(queue.onSidebarIdle()).toBeNull();
	});
});
