import { AGENT_REVIEW_RESULT_END, AGENT_REVIEW_RESULT_START } from "./reviewer-output";

export function buildReviewerPrompt(input: {
	title: string;
	prompt: string;
	baseRef: string;
	round: number;
	previousFixPrompts: string[];
}): string {
	const previousFixes =
		input.round > 1 && input.previousFixPrompts.length > 0
			? `\nEarlier fix prompts:\n${input.previousFixPrompts.map((fixPrompt, index) => `${index + 1}. ${fixPrompt}`).join("\n")}`
			: "";

	return `Review this task's changes. Do not edit files.

Task title:
${input.title}

Original task request (verbatim):
${input.prompt}

Base ref: ${input.baseRef}
Review round: ${input.round}${previousFixes}

Inspect the complete changes with \`git diff <merge-base>...HEAD\`, then inspect \`git status\` and \`git diff\` for working-tree changes. Compare the changes with the original task request.

Run the project's tests and verify that the app runs. Find app run instructions in package.json scripts, README files, or the Makefile. Do not edit files, run formatters or code generation, or update snapshots. If dependencies need installing, respect the lockfile (for example \`npm ci\` or \`pnpm install --frozen-lockfile\`). Stop every process you start.

If the app cannot run for reasons outside this task, set appVerified to false and explain why in appCheck; that is not a pass. If it fails because of this task's changes, use verdict fail and provide a concrete fixPrompt.

Return exactly one JSON object between these markers, with no other result blocks:
${AGENT_REVIEW_RESULT_START}
{
  "verdict": "pass | fail | cannot_verify",
  "appVerified": true,
  "appCheck": "what you ran and what happened",
  "tests": [{ "command": "command", "result": "result" }],
  "summary": { "whatWasDone": "...", "whatItAffects": "...", "againstRequest": "...", "howVerified": "...", "risks": "..." },
  "fixPrompt": null,
  "notes": null
}
${AGENT_REVIEW_RESULT_END}`;
}

export function buildFixPromptMessage(input: { fixPrompt: string; round: number; maxRounds: number }): string {
	return `[Kanban agent review — fix round ${input.round}/${input.maxRounds}]\nThese issues come from the Kanban reviewer. Fix them, then stop so the reviewer can check again.\n\n${input.fixPrompt}`;
}
