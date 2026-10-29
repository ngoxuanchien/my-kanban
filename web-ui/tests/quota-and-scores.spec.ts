import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

test("shows quota state and seeded agent scores", async ({ page }) => {
	const workspaceDir = process.env.KANBAN_SMOKE_WORKSPACE_DIR;
	if (!workspaceDir) throw new Error("Run this spec with npm run e2e:quota-scores.");

	await page.goto("/");

	const blockedCard = page.locator('[data-task-id="quota-blocked-smoke"]');
	const unblockedCard = page.locator('[data-task-id="quota-clear-smoke"]');
	await expect(blockedCard).toContainText("Out of quota");
	await expect(unblockedCard).not.toContainText("Out of quota");
	await expect(page.getByTestId("agent-score-strip")).toHaveText(
		"codex +4 (6 task) · antigravity 0 (1 task) · opencode −3 (4 task)",
	);

	await writeFile(join(workspaceDir, "agent-scores.json"), JSON.stringify({ version: 1, events: [] }));
	await page.reload();
	await expect(page.getByTestId("agent-score-strip")).toHaveCount(0);
});
