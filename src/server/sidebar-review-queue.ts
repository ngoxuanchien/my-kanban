export interface SidebarReviewTask {
	id: string;
	title: string;
	agentReviewEnabled?: boolean;
	reviewRound?: number;
}

export function createSidebarReviewQueue() {
	const queuedTaskIds = new Set<string>();
	const queue: Array<{ id: string; title: string; round: number }> = [];

	const enqueue = (task: SidebarReviewTask, round: number): void => {
		if (queuedTaskIds.has(task.id)) {
			return;
		}
		queuedTaskIds.add(task.id);
		queue.push({ id: task.id, title: task.title, round });
	};
	const formatWakeup = (task: { id: string; title: string; round: number }): string =>
		`[Kanban review] Task ${task.id} "${task.title}" is in Review, round ${task.round}/3. Review it now.`;

	return {
		onTaskTurnEnd(task: SidebarReviewTask): { round: number } | null {
			if (task.agentReviewEnabled !== true || (task.reviewRound ?? 0) >= 3) {
				return null;
			}
			const round = (task.reviewRound ?? 0) + 1;
			enqueue(task, round);
			return { round };
		},
		onSidebarIdle(): string | null {
			const task = queue[0];
			return task ? formatWakeup(task) : null;
		},
		onTaskDelivered(prompt: string): void {
			if (queue[0] && formatWakeup(queue[0]) === prompt) {
				queuedTaskIds.delete(queue.shift()?.id ?? "");
			}
		},
		restoreTask(task: SidebarReviewTask, round: number): void {
			enqueue(task, round);
		},
		onTaskDone(taskId: string): void {
			queuedTaskIds.delete(taskId);
			const index = queue.findIndex((task) => task.id === taskId);
			if (index >= 0) queue.splice(index, 1);
		},
		size: () => queue.length,
	};
}
