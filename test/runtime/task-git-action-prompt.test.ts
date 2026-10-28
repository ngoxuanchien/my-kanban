import { describe, expect, it } from "vitest";

import { buildTaskGitActionPrompt, TASK_GIT_BASE_REF_PROMPT_VARIABLE } from "../../src/core/task-git-action-prompt";

describe("buildTaskGitActionPrompt", () => {
	it("interpolates the shared base ref variable into custom templates", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "commit",
				baseRef: "main",
				templates: {
					commitPromptTemplate: `Commit onto ${TASK_GIT_BASE_REF_PROMPT_VARIABLE.token}.`,
				},
			}),
		).toBe("Commit onto main.");
	});

	it("falls back to the default action prompt when no template is configured", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				baseRef: "main",
			}),
		).toBe("Handle this pull request action using the provided git context.");
	});

	it("replaces every {{base_ref}} occurrence", () => {
		expect(
			buildTaskGitActionPrompt({
				action: "pr",
				baseRef: "develop",
				templates: {
					openPrPromptTemplate: "Rebase onto {{base_ref}}, then open a PR into {{base_ref}}.",
				},
			}),
		).toBe("Rebase onto develop, then open a PR into develop.");
	});
});
