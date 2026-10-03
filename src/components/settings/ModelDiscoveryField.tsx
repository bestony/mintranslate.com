import { useEffect, useMemo, useState } from "react";

import type {
	Connection,
	ConnectionCapabilities,
	ConnectionEdit,
	ProviderId,
} from "#/lib/connections/model";
import {
	createModelListController,
	type ModelListController,
	type ModelListResult,
} from "#/lib/connections/model-list";

/** Providers whose endpoints use the OpenAI `/models` protocol. */
export const MODEL_DISCOVERY_PROVIDERS = [
	"openai",
	"deepseek",
	"openrouter",
	"custom",
] as const satisfies readonly ProviderId[];

/** Whether the settings form may offer the model-list action. */
export function supportsModelDiscovery(provider: ProviderId): boolean {
	return MODEL_DISCOVERY_PROVIDERS.includes(
		provider as (typeof MODEL_DISCOVERY_PROVIDERS)[number],
	);
}

/** Merge static preset candidates with the latest endpoint candidates. */
export function mergeModelCandidates(
	staticModels: readonly string[],
	loadedModels: readonly string[],
): readonly string[] {
	return [...new Set([...staticModels, ...loadedModels])];
}

/** Apply only a known endpoint modality; unknown keeps the manual value. */
export function capabilitiesAfterModelDiscovery(
	capabilities: ConnectionCapabilities,
	vision: boolean | undefined,
): ConnectionCapabilities {
	return vision === undefined ? capabilities : { ...capabilities, vision };
}

type ModelListFailure = Extract<ModelListResult, { readonly ok: false }>;

interface ModelListUiState {
	readonly status: "idle" | "loading" | "success" | "error";
	readonly models: readonly string[];
	readonly source?: string;
	readonly vision?: boolean;
	readonly failure?: ModelListFailure;
}

export interface ModelDiscoveryFieldProps {
	readonly connection: Connection;
	readonly apiKey: string;
	readonly presetModels: readonly string[];
	readonly labelClass: string;
	readonly inputClass: string;
	readonly onChange: (edit: ConnectionEdit) => void;
	readonly modelListController?: ModelListController;
}

export function ModelDiscoveryField({
	connection,
	apiKey,
	presetModels,
	labelClass,
	inputClass,
	onChange,
	modelListController: injectedModelListController,
}: ModelDiscoveryFieldProps) {
	const [defaultModelListController] = useState(() =>
		createModelListController(),
	);
	const modelListController =
		injectedModelListController ?? defaultModelListController;
	const [online, setOnline] = useState(true);
	const [modelListState, setModelListState] = useState<ModelListUiState>({
		status: "idle",
		models: [],
	});
	const canDiscoverModels = supportsModelDiscovery(connection.provider);
	const modelListSource = `${connection.id}\u0000${connection.provider}\u0000${connection.endpoint}`;
	const modelCandidates = useMemo(
		() => mergeModelCandidates(presetModels, modelListState.models),
		[presetModels, modelListState.models],
	);

	useEffect(() => {
		if (typeof window === "undefined") return;
		const updateOnline = () => setOnline(window.navigator.onLine !== false);
		updateOnline();
		window.addEventListener("online", updateOnline);
		window.addEventListener("offline", updateOnline);
		return () => {
			window.removeEventListener("online", updateOnline);
			window.removeEventListener("offline", updateOnline);
		};
	}, []);

	useEffect(() => {
		return () => modelListController.cancel();
	}, [modelListController]);

	useEffect(() => {
		modelListController.cancel();
		setModelListState({ status: "idle", models: [], source: modelListSource });
	}, [modelListController, modelListSource]);

	async function loadModelList() {
		if (!canDiscoverModels || !online) return;

		setModelListState({ status: "loading", models: modelListState.models });
		const outcome = await modelListController.request({
			endpoint: connection.endpoint,
			apiKey,
		});
		if (outcome.kind === "superseded") return;

		const loaded = outcome.value;
		if (!loaded.ok) {
			setModelListState({ status: "error", models: [], failure: loaded });
			return;
		}

		setModelListState({
			status: "success",
			models: loaded.models,
			...(loaded.vision !== undefined && { vision: loaded.vision }),
		});
		// Unknown modality is deliberately a no-op: the user's manual capability
		// choice remains the source of truth until the endpoint says otherwise.
		if (loaded.vision !== undefined) {
			onChange({
				capabilities: capabilitiesAfterModelDiscovery(
					connection.capabilities,
					loaded.vision,
				),
			});
		}
	}

	return (
		<label className="block">
			<span className={labelClass}>Model</span>
			<input
				id="connection-model"
				name="connection-model"
				className={inputClass}
				value={connection.model}
				list={`models-${connection.id}`}
				onChange={(event) => onChange({ model: event.target.value })}
			/>
			<datalist id={`models-${connection.id}`}>
				{modelCandidates.map((model) => (
					<option key={model} value={model} />
				))}
			</datalist>
			{canDiscoverModels && (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<button
						type="button"
						id={`load-models-${connection.id}`}
						aria-label="加载模型"
						className="min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50"
						disabled={
							!online ||
							modelListState.status === "loading" ||
							connection.endpoint.trim() === ""
						}
						onClick={loadModelList}
					>
						{modelListState.status === "loading" ? "加载中…" : "加载模型"}
					</button>
					{!online && (
						<span className="text-muted-foreground text-xs">
							当前处于离线状态，无法获取模型列表。
						</span>
					)}
				</div>
			)}
			{modelListState.status === "success" && (
				<div className="mt-2 text-muted-foreground text-xs">
					<p>已从端点加载 {modelListState.models.length} 个模型候选。</p>
					<p>
						{modelListState.vision === undefined
							? "未能从端点获取模态信息；保留手动能力设置。"
							: modelListState.vision
								? "视觉能力来自端点。"
								: "端点未声明视觉能力。"}
					</p>
				</div>
			)}
			{modelListState.status === "error" && modelListState.failure && (
				<div className="mt-2 text-muted-foreground text-xs">
					<p>{modelListState.failure.attribution.summary}</p>
					{modelListState.failure.diagnostic && (
						<p>诊断：{modelListState.failure.diagnostic}</p>
					)}
					{modelListState.failure.attribution.checklist && (
						<ul className="mt-2 list-disc space-y-2 pl-6">
							{modelListState.failure.attribution.checklist.map((item) => (
								<li key={item}>{item}</li>
							))}
						</ul>
					)}
				</div>
			)}
		</label>
	);
}
