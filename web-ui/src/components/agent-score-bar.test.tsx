import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentScoreBar } from "@/components/agent-score-bar";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("AgentScoreBar", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows agent scores with signed colors and pass/fail tooltip", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<AgentScoreBar
						agentScores={[
							{ agentId: "codex", score: 4, passes: 6, fails: 2, tasks: 6 },
							{ agentId: "antigravity", score: 0, passes: 0, fails: 0, tasks: 1 },
							{ agentId: "opencode", score: -3, passes: 1, fails: 4, tasks: 11 },
						]}
					/>
				</TooltipProvider>,
			);
		});

		const strip = container.querySelector('[data-testid="agent-score-strip"]');
		expect(strip?.textContent).toBe("codex +4 (6 tasks) · antigravity 0 (1 task) · opencode −3 (11 tasks)");
		expect(strip?.querySelector(".text-status-green")?.textContent).toBe("+4");
		expect(
			Array.from(strip?.querySelectorAll(".text-text-secondary") ?? []).some(
				(element) => element.textContent === "0",
			),
		).toBe(true);
		expect(strip?.querySelector(".text-status-red")?.textContent).toBe("−3");

		const firstAgent = strip?.querySelector("[data-state]") ?? strip?.firstElementChild?.querySelector("span");
		await act(async () => {
			firstAgent?.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
			await new Promise((resolve) => setTimeout(resolve, 450));
		});
		expect(document.body.textContent).toContain("6 pass · 2 fail · 6 task");
	});

	it.each([undefined, []])("hides the agent score strip when scores are empty", async (agentScores) => {
		await act(async () => {
			root.render(<AgentScoreBar agentScores={agentScores} />);
		});

		expect(container.querySelector('[data-testid="agent-score-strip"]')).toBeNull();
	});
});
