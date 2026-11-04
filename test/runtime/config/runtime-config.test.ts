import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	loadGlobalRuntimeConfig,
	loadRuntimeConfig,
	pickBestInstalledAgentIdFromDetected,
	saveRuntimeConfig,
	updateRuntimeConfig,
} from "../../../src/config/runtime-config";
import { isRuntimeAgentLaunchSupported } from "../../../src/core/agent-catalog";
import { DEFAULT_DIFFICULTY_MODEL_MAP, type DifficultyModelMap } from "../../../src/core/agent-model";
import { createTempDir } from "../../utilities/temp-dir";

function withTemporaryEnv<T>(
	input: {
		home: string;
		pathPrefix?: string;
		replacePath?: boolean;
	},
	run: () => Promise<T>,
): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousPath = process.env.PATH;
	process.env.HOME = input.home;
	process.env.USERPROFILE = input.home;
	if (input.pathPrefix) {
		process.env.PATH = input.replacePath
			? input.pathPrefix
			: previousPath
				? `${input.pathPrefix}${delimiter}${previousPath}`
				: input.pathPrefix;
	}
	return run().finally(() => {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		if (input.pathPrefix) {
			if (previousPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = previousPath;
			}
		}
	});
}

function writeFakeCommand(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		const scriptPath = join(binDir, `${command}.cmd`);
		writeFileSync(scriptPath, "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

describe.sequential("runtime-config auto agent selection", () => {
	it("selects agents using the configured priority order", () => {
		expect(pickBestInstalledAgentIdFromDetected(["codex", "opencode", "gemini"])).toBe("codex");
		expect(pickBestInstalledAgentIdFromDetected(["opencode", "droid", "gemini"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["kiro-cli", "gemini"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["droid", "gemini", "cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["gemini", "cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected(["claude", "codex", "cline"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["claude", "droid"])).toBe("claude");
		expect(pickBestInstalledAgentIdFromDetected(["cline"])).toBeNull();
		expect(pickBestInstalledAgentIdFromDetected([])).toBeNull();
	});

	it("auto-selects and persists when unset", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-");

		try {
			writeFakeCommand(tempBin, "opencode");
			writeFakeCommand(tempBin, "codex");
			writeFakeCommand(tempBin, "gemini");

			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				const isolatedPath = `${tempBin}${delimiter}/usr/bin${delimiter}/bin`;
				await withTemporaryEnv({ home: tempHome, pathPrefix: isolatedPath, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("codex");
					const persisted = JSON.parse(
						readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
					) as {
						selectedAgentId?: string;
						agentAutonomousModeEnabled?: boolean;
						readyForReviewNotificationsEnabled?: boolean;
						commitPromptTemplate?: string;
						openPrPromptTemplate?: string;
					};
					expect(persisted.selectedAgentId).toBe("codex");
					expect(persisted.agentAutonomousModeEnabled).toBeUndefined();
					expect(persisted.readyForReviewNotificationsEnabled).toBeUndefined();
					expect(persisted.commitPromptTemplate).toBeUndefined();
					expect(persisted.openPrPromptTemplate).toBeUndefined();

					const reloadedState = await loadRuntimeConfig(tempProject);
					expect(reloadedState.selectedAgentId).toBe("codex");
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not write config when no supported CLI is detected", async () => {
		if (process.platform === "win32") {
			return;
		}
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-default-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-default-");

		try {
			const previousShell = process.env.SHELL;
			try {
				process.env.SHELL = "/definitely-not-a-shell";
				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin, replacePath: true }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("claude");
					expect(existsSync(join(tempHome, ".cline", "kanban", "config.json"))).toBe(false);
				});
			} finally {
				if (previousShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = previousShell;
				}
			}
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats the home directory as global-only config scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-home-scope-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempHome);
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);

				const updated = await updateRuntimeConfig(tempHome, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");
				expect(updated.projectConfigPath).toBeNull();

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					shortcuts?: unknown;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.shortcuts).toBeUndefined();
			});
		} finally {
			cleanupHome();
		}
	});

	it("loads global runtime config without a project scope", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-global-only-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadGlobalRuntimeConfig();
				expect(state.globalConfigPath).toBe(join(tempHome, ".cline", "kanban", "config.json"));
				expect(state.projectConfigPath).toBeNull();
				expect(state.shortcuts).toEqual([]);
			});
		} finally {
			cleanupHome();
		}
	});

	it.each(["cline", "droid", "kiro", "gemini"] as const)(
		"normalizes unsupported configured agent %s to the default launch agent",
		async (agentId) => {
			const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-set-");
			const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-set-");
			const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-set-");

			try {
				writeFakeCommand(tempBin, "claude");
				writeFakeCommand(tempBin, "codex");

				const runtimeConfigDir = join(tempHome, ".cline", "kanban");
				mkdirSync(runtimeConfigDir, { recursive: true });
				writeFileSync(
					join(runtimeConfigDir, "config.json"),
					JSON.stringify(
						{
							selectedAgentId: agentId,
						},
						null,
						2,
					),
					"utf8",
				);

				await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
					const state = await loadRuntimeConfig(tempProject);
					expect(state.selectedAgentId).toBe("claude");
				});
			} finally {
				cleanupBin();
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it("keeps Antigravity as a supported configured launch agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-antigravity-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-antigravity-",
		);
		const runtimeConfigDir = join(tempHome, ".cline", "kanban");
		mkdirSync(runtimeConfigDir, { recursive: true });
		writeFileSync(join(runtimeConfigDir, "config.json"), JSON.stringify({ selectedAgentId: "antigravity" }), "utf8");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				expect(isRuntimeAgentLaunchSupported("antigravity")).toBe(true);
				expect((await loadRuntimeConfig(tempProject)).selectedAgentId).toBe("antigravity");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("does not auto-select when global config file already exists without selected agent", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-existing-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-existing-");
		const { path: tempBin, cleanup: cleanupBin } = createTempDir("kanban-bin-runtime-config-existing-");

		try {
			writeFakeCommand(tempBin, "codex");

			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(
				join(runtimeConfigDir, "config.json"),
				JSON.stringify(
					{
						readyForReviewNotificationsEnabled: true,
					},
					null,
					2,
				),
				"utf8",
			);

			await withTemporaryEnv({ home: tempHome, pathPrefix: tempBin }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.selectedAgentId).toBe("claude");
			});
		} finally {
			cleanupBin();
			cleanupProject();
			cleanupHome();
		}
	});

	it("save omits default keys when they were not previously set", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-omit-defaults-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-omit-defaults-",
		);

		try {
			const runtimeConfigDir = join(tempHome, ".cline", "kanban");
			mkdirSync(runtimeConfigDir, { recursive: true });
			writeFileSync(join(runtimeConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
					commitPromptTemplate?: string;
					openPrPromptTemplate?: string;
				};
				expect(globalPayload.selectedAgentId).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
				expect(globalPayload.commitPromptTemplate).toBeUndefined();
				expect(globalPayload.openPrPromptTemplate).toBeUndefined();
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes an existing empty project config file when no shortcuts are saved", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-cleanup-empty-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-cleanup-empty-",
		);

		try {
			const runtimeProjectConfigDir = join(tempProject, ".cline", "kanban");
			mkdirSync(runtimeProjectConfigDir, { recursive: true });
			writeFileSync(join(runtimeProjectConfigDir, "config.json"), "{}", "utf8");

			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("removes the project config file when the last shortcut is deleted", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-remove-last-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-remove-last-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const current = await loadRuntimeConfig(tempProject);
				await saveRuntimeConfig(tempProject, {
					selectedAgentId: "cline",
					selectedShortcutLabel: null,
					agentAutonomousModeEnabled: true,
					readyForReviewNotificationsEnabled: true,
					shortcuts: [{ label: "Ship", command: "npm run ship", icon: "rocket" }],
					commitPromptTemplate: current.commitPromptTemplateDefault,
					openPrPromptTemplate: current.openPrPromptTemplateDefault,
				});
				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(true);

				await updateRuntimeConfig(tempProject, {
					shortcuts: [],
				});

				expect(existsSync(join(tempProject, ".cline", "kanban", "config.json"))).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("updateRuntimeConfig supports partial updates", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-partial-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-partial-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const updated = await updateRuntimeConfig(tempProject, {
					selectedAgentId: "codex",
				});
				expect(updated.selectedAgentId).toBe("codex");

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					selectedAgentId?: string;
					selectedShortcutLabel?: string;
					agentAutonomousModeEnabled?: boolean;
					readyForReviewNotificationsEnabled?: boolean;
				};
				expect(globalPayload.selectedAgentId).toBe("codex");
				expect(globalPayload.selectedShortcutLabel).toBeUndefined();
				expect(globalPayload.agentAutonomousModeEnabled).toBeUndefined();
				expect(globalPayload.readyForReviewNotificationsEnabled).toBeUndefined();
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists autonomous mode when disabled", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-autonomous-disabled-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-autonomous-disabled-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, {
					agentAutonomousModeEnabled: false,
				});
				expect(updated.agentAutonomousModeEnabled).toBe(false);

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					agentAutonomousModeEnabled?: boolean;
				};
				expect(globalPayload.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("loads legacy reviewerAgent config without exposing the removed setting", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-legacy-reviewer-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-legacy-reviewer-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const configPath = join(tempHome, ".cline", "kanban", "config.json");
				mkdirSync(join(tempHome, ".cline", "kanban"), { recursive: true });
				writeFileSync(configPath, JSON.stringify({ reviewerAgent: "cross" }), "utf8");

				const current = await loadRuntimeConfig(tempProject);
				expect(current).not.toHaveProperty("reviewerAgent");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("preserves concurrent config updates across processes", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-concurrent-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir("kanban-project-runtime-config-concurrent-");

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				await loadRuntimeConfig(tempProject);

				const [selectedAgentState, autonomousModeState] = await Promise.all([
					updateRuntimeConfig(tempProject, {
						selectedAgentId: "codex",
					}),
					updateRuntimeConfig(tempProject, {
						agentAutonomousModeEnabled: false,
					}),
				]);

				expect(selectedAgentState.selectedAgentId).toBe("codex");
				expect(autonomousModeState.agentAutonomousModeEnabled).toBe(false);

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.selectedAgentId).toBe("codex");
				expect(reloaded.agentAutonomousModeEnabled).toBe(false);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("defaults the claude default model to opus when the config has none", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-claude-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-claude-default-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.claudeDefaultModel).toBe("opus");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("persists the claude default model and reloads it", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-claude-persist-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-claude-persist-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, {
					claudeDefaultModel: "haiku",
				});
				expect(updated.claudeDefaultModel).toBe("haiku");

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as {
					claudeDefaultModel?: string;
				};
				expect(globalPayload.claudeDefaultModel).toBe("haiku");

				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.claudeDefaultModel).toBe("haiku");
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("defaults the difficulty model map to the shipped defaults when the config has none", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-difficulty-default-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-difficulty-default-",
		);

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const state = await loadRuntimeConfig(tempProject);
				expect(state.difficultyModelMap).toEqual(DEFAULT_DIFFICULTY_MODEL_MAP);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("round-trips a saved difficulty model map through the global config file", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-runtime-config-difficulty-persist-");
		const { path: tempProject, cleanup: cleanupProject } = createTempDir(
			"kanban-project-runtime-config-difficulty-persist-",
		);
		const map: DifficultyModelMap = {
			codex: { 3: { model: "gpt-5.6-terra", reasoningEffort: "high" } },
			opencode: { 1: { model: "opencode/big-pickle" } },
			claude: { 5: { model: "sonnet" } },
		};

		try {
			await withTemporaryEnv({ home: tempHome }, async () => {
				const updated = await updateRuntimeConfig(tempProject, { difficultyModelMap: map });
				expect(updated.difficultyModelMap).toEqual(map);

				const globalPayload = JSON.parse(
					readFileSync(join(tempHome, ".cline", "kanban", "config.json"), "utf8"),
				) as { difficultyModelMap?: unknown };
				expect(globalPayload.difficultyModelMap).toEqual(map);

				// Saving another global field keeps the stored map.
				await updateRuntimeConfig(tempProject, { claudeDefaultModel: "haiku" });
				const reloaded = await loadRuntimeConfig(tempProject);
				expect(reloaded.difficultyModelMap).toEqual(map);
				expect((await loadGlobalRuntimeConfig()).difficultyModelMap).toEqual(map);
			});
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});

describe("project GitHub issue sync setting", () => {
	it("defaults githubIssueSyncEnabled to false and loads project true", async () => {
		const temp = createTempDir("github-config-");
		try {
			await withTemporaryEnv({ home: temp.path }, async () => {
				const repo = join(temp.path, "repo");
				expect((await loadRuntimeConfig(repo)).githubIssueSyncEnabled).toBe(false);
				mkdirSync(join(repo, ".cline", "kanban"), { recursive: true });
				writeFileSync(
					join(repo, ".cline", "kanban", "config.json"),
					JSON.stringify({ githubIssueSyncEnabled: true }),
				);
				expect((await loadRuntimeConfig(repo)).githubIssueSyncEnabled).toBe(true);
			});
		} finally {
			temp.cleanup();
		}
	});
	it("writes githubIssueSyncEnabled to project config only and preserves it across shortcut updates", async () => {
		const temp = createTempDir("github-config-");
		try {
			await withTemporaryEnv({ home: temp.path }, async () => {
				const repo = join(temp.path, "repo");
				await updateRuntimeConfig(repo, { githubIssueSyncEnabled: true });
				await updateRuntimeConfig(repo, { shortcuts: [] });
				expect(JSON.parse(readFileSync(join(repo, ".cline", "kanban", "config.json"), "utf8"))).toEqual({
					githubIssueSyncEnabled: true,
				});
				const globalPath = join(temp.path, ".cline", "kanban", "config.json");
				if (existsSync(globalPath))
					expect(JSON.parse(readFileSync(globalPath, "utf8"))).not.toHaveProperty("githubIssueSyncEnabled");
				expect((await loadGlobalRuntimeConfig()).githubIssueSyncEnabled).toBe(false);
				await updateRuntimeConfig(repo, { githubIssueSyncEnabled: false });
				expect((await loadRuntimeConfig(repo)).githubIssueSyncEnabled).toBe(false);
			});
		} finally {
			temp.cleanup();
		}
	});
});
