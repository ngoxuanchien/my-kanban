import { RefreshCw } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { RuntimeAgentModelCatalog, RuntimeAgentModelCatalogsResponse, RuntimeClaudeModel } from "@/runtime/types";
import type { DifficultyModelCell, DifficultyModelMap, TaskDifficulty } from "../../../src/core/agent-model";

const DIFFICULTIES: TaskDifficulty[] = [1, 2, 3, 4, 5];
const CLAUDE_MODELS: RuntimeClaudeModel[] = ["haiku", "sonnet", "opus"];

/** Catalog-backed select; free text when the catalog could not be read. */
export function CatalogField({
	ariaLabel,
	value,
	options,
	emptyLabel,
	freeText = false,
	disabled = false,
	onChange,
}: {
	ariaLabel: string;
	value: string | undefined;
	options: string[];
	emptyLabel: string;
	freeText?: boolean;
	disabled?: boolean;
	onChange: (value: string | undefined) => void;
}): ReactElement {
	if (freeText) {
		return (
			<input
				aria-label={ariaLabel}
				value={value ?? ""}
				placeholder={emptyLabel}
				disabled={disabled}
				onChange={(event) => onChange(event.currentTarget.value.trim() || undefined)}
				className="h-7 w-full min-w-0 rounded-md border border-border-bright bg-surface-2 px-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none disabled:opacity-40"
			/>
		);
	}
	// A stored value missing from the catalog stays visible so it is not silently replaced.
	const allOptions = value && !options.includes(value) ? [...options, value] : options;
	return (
		<NativeSelect
			size="sm"
			fill
			aria-label={ariaLabel}
			value={value ?? ""}
			disabled={disabled}
			onChange={(event) => onChange(event.currentTarget.value || undefined)}
		>
			<option value="">{emptyLabel}</option>
			{allOptions.map((option) => (
				<option key={option} value={option}>
					{option}
				</option>
			))}
		</NativeSelect>
	);
}

function withCell<C>(
	rows: Partial<Record<TaskDifficulty, C>> | undefined,
	difficulty: TaskDifficulty,
	cell: C | undefined,
): Partial<Record<TaskDifficulty, C>> {
	const next = { ...rows };
	if (cell) {
		next[difficulty] = cell;
	} else {
		delete next[difficulty];
	}
	return next;
}

function catalogModelIds(catalog: RuntimeAgentModelCatalog | undefined): string[] {
	return catalog?.ok ? catalog.models.map((model) => model.id) : [];
}

function catalogEfforts(catalog: RuntimeAgentModelCatalog | undefined, modelId: string | undefined): string[] {
	return catalog?.ok ? (catalog.models.find((model) => model.id === modelId)?.efforts ?? []) : [];
}

function codexCellForModel(
	catalog: RuntimeAgentModelCatalog | undefined,
	model: string | undefined,
	currentEffort: string | undefined,
): DifficultyModelCell | undefined {
	if (!model) {
		return undefined;
	}
	const keepEffort = currentEffort && (!catalog?.ok || catalogEfforts(catalog, model).includes(currentEffort));
	return keepEffort ? { model, reasoningEffort: currentEffort } : { model };
}

export function DifficultyModelTable({
	value,
	catalogs,
	disabled = false,
	onChange,
	onRefresh,
}: {
	value: DifficultyModelMap;
	catalogs: RuntimeAgentModelCatalogsResponse | null;
	disabled?: boolean;
	onChange: (next: DifficultyModelMap) => void;
	onRefresh?: () => void;
}): ReactElement {
	const codexCatalog = catalogs?.codex;
	const opencodeCatalog = catalogs?.opencode;
	return (
		<div className="flex flex-col gap-2">
			<div className="overflow-x-auto">
				<table className="w-full border-collapse text-[12px] text-text-primary">
					<thead>
						<tr className="text-left text-text-secondary">
							<th className="px-2 py-1 font-medium">Difficulty</th>
							<th className="px-2 py-1 font-medium">Codex</th>
							<th className="px-2 py-1 font-medium">OpenCode</th>
							<th className="px-2 py-1 font-medium">Claude</th>
						</tr>
					</thead>
					<tbody>
						{DIFFICULTIES.map((difficulty) => {
							const codexCell = value.codex?.[difficulty];
							return (
								<tr key={difficulty} className="border-t border-border align-top">
									<th className="px-2 py-1.5 font-medium">{difficulty}</th>
									<td className="px-2 py-1.5">
										<div className="flex min-w-[220px] gap-1">
											<CatalogField
												ariaLabel={`Codex model for difficulty ${difficulty}`}
												value={codexCell?.model}
												options={catalogModelIds(codexCatalog)}
												emptyLabel="Default"
												freeText={codexCatalog?.ok === false}
												disabled={disabled}
												onChange={(model) =>
													onChange({
														...value,
														codex: withCell(
															value.codex,
															difficulty,
															codexCellForModel(codexCatalog, model, codexCell?.reasoningEffort),
														),
													})
												}
											/>
											<CatalogField
												ariaLabel={`Codex effort for difficulty ${difficulty}`}
												value={codexCell?.reasoningEffort}
												options={catalogEfforts(codexCatalog, codexCell?.model)}
												emptyLabel="Default"
												freeText={codexCatalog?.ok === false}
												disabled={disabled || !codexCell?.model}
												onChange={(reasoningEffort) =>
													onChange({
														...value,
														codex: withCell(value.codex, difficulty, {
															...(codexCell?.model ? { model: codexCell.model } : {}),
															...(reasoningEffort ? { reasoningEffort } : {}),
														}),
													})
												}
											/>
										</div>
									</td>
									<td className="px-2 py-1.5">
										<div className="min-w-[140px]">
											<CatalogField
												ariaLabel={`OpenCode model for difficulty ${difficulty}`}
												value={value.opencode?.[difficulty]?.model}
												options={catalogModelIds(opencodeCatalog)}
												emptyLabel="Default"
												freeText={opencodeCatalog?.ok === false}
												disabled={disabled}
												onChange={(model) =>
													onChange({
														...value,
														opencode: withCell(value.opencode, difficulty, model ? { model } : undefined),
													})
												}
											/>
										</div>
									</td>
									<td className="px-2 py-1.5">
										<div className="min-w-[100px]">
											<CatalogField
												ariaLabel={`Claude model for difficulty ${difficulty}`}
												value={value.claude?.[difficulty]?.model}
												options={CLAUDE_MODELS}
												emptyLabel="Default"
												disabled={disabled}
												onChange={(model) =>
													onChange({
														...value,
														claude: withCell(
															value.claude,
															difficulty,
															model ? { model: model as RuntimeClaudeModel } : undefined,
														),
													})
												}
											/>
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{onRefresh ? (
				<div>
					<Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} disabled={disabled} onClick={onRefresh}>
						Refresh models
					</Button>
				</div>
			) : null}
		</div>
	);
}
