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
