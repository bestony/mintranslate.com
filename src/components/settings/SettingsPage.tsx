/**
 * Settings page.
 *
 * Composes the connection list, the per-connection form, and the tier and style
 * sections. All persistence and rule enforcement lives in the connection store;
 * this component only renders and dispatches.
 */

import { useEffect, useState } from "react";
import { saveId } from "#/lib/analytics/config";
import { useAnalytics } from "#/lib/analytics/use-analytics";
import {
	defaultConnectionName,
	type ModelTier,
	PROVIDER_IDS,
	type ProviderId,
} from "#/lib/connections/model";
import { presetDefaults, presetFor } from "#/lib/connections/presets";
import { exportConfiguration } from "#/lib/connections/storage";
import { useConnectionStore } from "#/lib/connections/store";
import {
	isTranslationStyleId,
	MAX_CUSTOM_INSTRUCTION_LENGTH,
	TRANSLATION_STYLES,
	type TranslationStyleId,
} from "#/lib/connections/styles";
import { createConnectionTestController } from "#/lib/connections/test-controller";
import { describeTierTarget, resolveTier } from "#/lib/connections/tiers";
import { maskSecret } from "#/lib/credentials/redact";
import { createTranslationMemoryPreference } from "#/lib/translation-memory";
import { usePwa } from "../pwa/usePwa";
import { ConnectionForm, PresetHint } from "./ConnectionForm";
import { PrivacyNotice } from "./PrivacyNotice";

const sectionClass = "island-shell mt-6 rounded-md p-6";
/** Primary action. `min-h-11` is the 44px touch target; the fill is the darker
    primary because white on the decorative one fails AA. */
const buttonClass =
	"min-h-11 rounded-md bg-primary-strong px-4 text-primary-foreground text-sm disabled:opacity-50";
const ghostButtonClass =
	"min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50";
/** Secondary/compact control. */
const smallButtonClass =
	"min-h-11 rounded-md border border-border px-4 text-muted-foreground text-xs";

/** Tier and prompt-style settings. */
function BehaviourSettings({
	tier,
	onTierChange,
	style,
	onStyleChange,
	customInstruction,
	onCustomInstructionChange,
	instructionNotice,
	usableConnections,
}: {
	readonly tier: ModelTier;
	readonly onTierChange: (tier: ModelTier) => void;
	readonly style: TranslationStyleId;
	readonly onStyleChange: (style: TranslationStyleId) => void;
	readonly customInstruction: string;
	readonly onCustomInstructionChange: (value: string) => void;
	readonly instructionNotice?: string;
	readonly usableConnections: ReturnType<
		typeof useConnectionStore
	>["usableConnections"];
}) {
	return (
		<section className={sectionClass}>
			<h2 className="font-semibold text-xl">翻译行为</h2>

			<div className="mt-4">
				<p className="font-medium text-sm">模型档位</p>
				<p className="mt-2 text-muted-foreground text-xs">
					档位只在你已配置并测试通过的连接中选择；未配置的档位会明确提示，不会静默改用另一档。
				</p>
				<div className="mt-2 flex flex-wrap gap-4 text-sm">
					{(["advanced", "fast"] as ModelTier[]).map((option) => {
						const resolution = resolveTier(option, usableConnections);
						return (
							<label key={option} className="flex min-h-11 items-center gap-2">
								<input
									type="radio"
									id={`tier-${option}`}
									name="tier"
									checked={tier === option}
									onChange={() => onTierChange(option)}
								/>
								{option === "advanced" ? "高级" : "快速"}
								<span className="text-muted-foreground text-xs">
									·{" "}
									{resolution.kind === "resolved"
										? `${resolution.connection.name}（${resolution.connection.model}）${resolution.derived ? " · 自动推导" : ""}`
										: resolution.reason}
								</span>
							</label>
						);
					})}
				</div>
				<p className="mt-2 text-muted-foreground text-xs">
					当前「{tier === "advanced" ? "高级" : "快速"}」档使用：
					{describeTierTarget(tier, usableConnections)}
				</p>
			</div>

			<div className="mt-6">
				<p className="font-medium text-sm">翻译风格</p>
				<div className="mt-2 flex flex-wrap gap-2">
					{TRANSLATION_STYLES.map((entry) => (
						<button
							key={entry.id}
							type="button"
							title={entry.description}
							className={
								style === entry.id
									? "min-h-11 rounded-sm bg-primary-strong px-4 text-primary-foreground text-xs"
									: "min-h-11 rounded-sm border border-border px-4 text-xs"
							}
							onClick={() => onStyleChange(entry.id)}
						>
							{entry.label}
						</button>
					))}
				</div>
				<p className="mt-2 text-muted-foreground text-xs">
					{TRANSLATION_STYLES.find((entry) => entry.id === style)?.description}
				</p>
			</div>

			<div className="mt-6">
				<label className="block">
					<span className="font-medium text-sm">自定义附加指令（可选）</span>
					<textarea
						className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-4 text-sm"
						id="custom-instruction"
						name="custom-instruction"
						value={customInstruction}
						maxLength={MAX_CUSTOM_INSTRUCTION_LENGTH + 1}
						onChange={(event) => onCustomInstructionChange(event.target.value)}
					/>
				</label>
				<p className="mt-2 text-muted-foreground text-xs">
					{customInstruction.length} / {MAX_CUSTOM_INSTRUCTION_LENGTH}{" "}
					字符。该指令只会附加到 用户消息侧，不会覆盖应用自身的系统级约束。
				</p>
				{instructionNotice && (
					<p className="mt-2 text-foreground text-xs">{instructionNotice}</p>
				)}
			</div>
		</section>
	);
}

export function SettingsPage() {
	const store = useConnectionStore();
	const [memoryPreference] = useState(() =>
		createTranslationMemoryPreference(),
	);
	const [memoryEnabled, setMemoryEnabled] = useState(true);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [exportIncludeKeys, setExportIncludeKeys] = useState(false);
	const [exportNotice, setExportNotice] = useState<string | undefined>(
		undefined,
	);
	const [clearConfirming, setClearConfirming] = useState(false);
	const [privacyOpen, setPrivacyOpen] = useState(false);
	/** Install guidance and the platform capability matrix. */
	const pwa = usePwa();
	const [instructionNotice, setInstructionNotice] = useState<
		string | undefined
	>(undefined);
	const [style, setStyle] = useState<TranslationStyleId>("free");
	const [customInstruction, setCustomInstruction] = useState("");
	// One controller for the page: it owns per-connection pacing and lets this
	// component abort an in-flight test when the user switches or deletes.
	const [testController] = useState(() => createConnectionTestController());
	/**
	 * The toggle and the deployment-controlled field.
	 *
	 * Page views and script injection belong to the shell, so this binding no
	 * longer initialises analytics — it only consumes the shared tracker. The
	 * settings route previously owned initialisation, which is why analytics was
	 * active there alone.
	 */
	const analyticsBinding = useAnalytics();
	const analytics = analyticsBinding.analytics;

	useEffect(() => {
		setMemoryEnabled(memoryPreference.mount());
	}, [memoryPreference]);

	const currentId = editingId ?? store.connections[0]?.id ?? null;
	const current = store.connections.find(
		(connection) => connection.id === currentId,
	);

	function addConnection(provider: ProviderId) {
		const id = store.createFromPreset(provider);
		setEditingId(id);
		analytics.track("provider_config_save", {
			provider,
			is_custom_endpoint: provider === "custom",
			has_base_url_override: false,
		});
	}

	function changeProvider(provider: ProviderId) {
		if (!current) return;
		// The endpoint is about to be repointed, so any running test for it is
		// testing a target the user has already left.
		testController.abort(current.id);
		// Selecting a preset fills the endpoint and first suggested model, so the
		// user only has to supply a key (spec `provider-connections`).
		const defaults = presetDefaults(provider);
		const label = presetFor(provider)?.label ?? "自定义";
		store.update(current.id, {
			provider,
			endpoint: defaults.endpoint,
			model: defaults.models[0] ?? "",
			capabilities: defaults.capabilities,
			name: defaultConnectionName(label, defaults.models[0] ?? ""),
		});
		analytics.track("provider_config_save", {
			provider,
			is_custom_endpoint: provider === "custom",
			has_base_url_override: defaults.endpoint !== "",
		});
	}

	function activateCurrent() {
		if (!current) return;
		const outcome = store.activate(current.id);
		if (!outcome.ok) setExportNotice(outcome.reason);
		else setExportNotice(undefined);
	}

	function runExport() {
		if (exportIncludeKeys) {
			// Keys require an explicit second confirmation before they leave the app.
			const confirmed = window.confirm(
				"导出的内容将包含明文 API Key，请确认你了解风险。继续导出？",
			);
			if (!confirmed) return;
		}
		const payload = exportConfiguration(store.connections, exportIncludeKeys);
		const blob = new Blob([payload], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = "mintranslate-connections.json";
		anchor.click();
		URL.revokeObjectURL(url);
		setExportNotice(
			exportIncludeKeys ? "已导出（含密钥）。" : "已导出（不含密钥）。",
		);
	}

	function clearKeys() {
		if (!clearConfirming) {
			setClearConfirming(true);
			return;
		}
		store.clearAllKeys();
		setClearConfirming(false);
		setExportNotice("已清除所有密钥。");
	}

	function updateInstruction(value: string) {
		// Reject rather than truncate, so the user is told their text was not
		// fully accepted (spec `prompt-styles`).
		if (value.length > MAX_CUSTOM_INSTRUCTION_LENGTH) {
			setInstructionNotice(
				`自定义指令上限为 ${MAX_CUSTOM_INSTRUCTION_LENGTH} 个字符，超出部分未被接受。`,
			);
			setCustomInstruction(value.slice(0, MAX_CUSTOM_INSTRUCTION_LENGTH));
			return;
		}
		setInstructionNotice(undefined);
		setCustomInstruction(value);
	}

	return (
		<>
			{store.loadWarning && (
				<p className="mb-4 rounded-md border border-border bg-surface p-4 text-sm">
					{store.loadWarning}
				</p>
			)}

			<section className={sectionClass}>
				<h2 className="font-semibold text-xl">模型连接</h2>
				<div className="mt-2">
					<PresetHint />
				</div>

				<div className="mt-4 flex flex-wrap gap-2">
					{store.connections.map((connection) => (
						<button
							key={connection.id}
							type="button"
							className={
								connection.id === currentId
									? "min-h-11 rounded-md bg-primary-strong px-4 text-primary-foreground text-sm"
									: ghostButtonClass
							}
							onClick={() => {
								// Switching away abandons any test for the previous
								// connection, so its result cannot land on the new one.
								if (currentId !== null && currentId !== connection.id) {
									testController.abort(currentId);
								}
								setEditingId(connection.id);
							}}
						>
							{connection.name}
							{connection.id === store.activeId && " · 使用中"}
						</button>
					))}
					<select
						id="add-connection"
						name="add-connection"
						aria-label="新增连接"
						className={ghostButtonClass}
						value=""
						onChange={(event) => {
							if (event.target.value !== "")
								addConnection(event.target.value as ProviderId);
						}}
					>
						<option value="">+ 新增连接…</option>
						{PROVIDER_IDS.map((id) => (
							<option key={id} value={id}>
								{presetFor(id)?.label ?? id}
							</option>
						))}
					</select>
				</div>

				{current ? (
					<div className="mt-6">
						<ConnectionForm
							connection={current}
							apiKey={store.keyFor(current.id)}
							onChange={(edit) => store.update(current.id, edit)}
							onProviderChange={changeProvider}
							onKeyChange={(key) => store.setKey(current.id, key)}
							testController={testController}
							onTested={(status, detail) =>
								store.setStatus(current.id, status, detail)
							}
						/>
						<div className="mt-4 flex flex-wrap gap-4">
							<button
								type="button"
								className={buttonClass}
								onClick={activateCurrent}
								disabled={current.id === store.activeId}
							>
								{current.id === store.activeId ? "当前使用中" : "设为当前模型"}
							</button>
							<button
								type="button"
								className={ghostButtonClass}
								onClick={() => {
									// Abort first: a test still running for a deleted
									// connection must not write back a status.
									testController.abort(current.id);
									store.remove(current.id);
									setEditingId(null);
								}}
							>
								删除此连接
							</button>
						</div>
					</div>
				) : (
					<p className="mt-4 text-muted-foreground text-sm">
						还没有任何连接。选择一个预设开始配置；未配置连接时应用仍可正常使用，只是无法翻译。
					</p>
				)}

				{!store.activeId && store.connections.length > 0 && (
					<p className="mt-4 text-foreground text-sm ">
						当前没有生效的连接。请先通过连接测试，再点「设为当前模型」。
					</p>
				)}

				{exportNotice && (
					<p className="mt-4 text-muted-foreground text-sm">{exportNotice}</p>
				)}
			</section>

			<BehaviourSettings
				tier={store.tier}
				onTierChange={store.setTier}
				style={style}
				onStyleChange={(next) => {
					if (isTranslationStyleId(next)) setStyle(next);
				}}
				customInstruction={customInstruction}
				onCustomInstructionChange={updateInstruction}
				instructionNotice={instructionNotice}
				usableConnections={store.usableConnections}
			/>

			<section className={sectionClass}>
				<h2 className="font-semibold text-xl">本地翻译记忆</h2>
				<p className="mt-2 text-muted-foreground text-sm">
					启用后，翻译结果会在本浏览器中保存并复用。原文、译文和模型上下文不会上传到
					MinTranslate。
				</p>
				<label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
					<input
						type="checkbox"
						id="translation-memory-enabled"
						name="translation-memory-enabled"
						checked={memoryEnabled}
						onChange={(event) => {
							const next = event.target.checked;
							setMemoryEnabled(next);
							memoryPreference.setEnabled(next);
						}}
					/>
					启用翻译记忆
				</label>
			</section>

			<section className={sectionClass}>
				<h2 className="font-semibold text-xl">匿名使用统计</h2>
				<p className="mt-2 text-muted-foreground text-sm">
					默认开启，仅上报匿名的事件与元数据（不含翻译内容与密钥）。关闭后立即停止上报并清理已写入的统计
					cookie，刷新后也不会重新加载。
				</p>

				<label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
					<input
						type="checkbox"
						id="statistics-enabled"
						name="statistics-enabled"
						checked={analyticsBinding.statisticsOn}
						onChange={(event) =>
							analyticsBinding.setStatisticsOn(event.target.checked)
						}
					/>
					匿名使用统计
				</label>

				<div className="mt-4">
					<label className="block text-sm">
						<span className="font-medium">测量 ID（可选）</span>
						<input
							id="measurement-id"
							name="measurement-id"
							className="mt-2 w-full max-w-sm rounded-md border border-input bg-background min-h-11 px-4 text-sm disabled:opacity-60"
							placeholder="G-XXXXXXXXXX"
							value={
								analyticsBinding.idFromDeployment
									? "由部署配置提供"
									: analyticsBinding.editableId
							}
							disabled={analyticsBinding.idFromDeployment}
							aria-readonly={analyticsBinding.idFromDeployment}
							onChange={(event) => {
								// Persisted immediately: the value is only read when the app
								// next resolves its configuration.
								saveId(event.target.value);
							}}
						/>
					</label>
					<p className="mt-2 text-muted-foreground text-xs">
						{analyticsBinding.idFromDeployment
							? "当前测量 ID 由部署配置提供，无法在此处覆盖。"
							: "留空且部署未提供时，不会加载任何统计脚本。"}
					</p>
				</div>

				<PrivacyNotice
					open={privacyOpen}
					onToggle={() => setPrivacyOpen((current) => !current)}
				/>
			</section>

			<section className={sectionClass}>
				<h2 className="font-semibold text-xl">安装与离线</h2>

				{pwa.installGuidance.installed ? (
					<p className="mt-2 text-muted-foreground text-sm">
						应用已安装，正在以独立窗口运行。
					</p>
				) : pwa.installGuidance.mode === "prompt" ? (
					<div className="mt-2">
						<button
							type="button"
							className={buttonClass}
							onClick={pwa.requestInstall}
						>
							安装到桌面
						</button>
					</div>
				) : pwa.installGuidance.mode === "manual" ? (
					<p className="mt-2 text-muted-foreground text-sm">
						{pwa.installGuidance.instructions}
					</p>
				) : (
					<p className="mt-2 text-muted-foreground text-sm">
						{pwa.installGuidance.unsupportedNotice}
					</p>
				)}

				<div className="mt-4">
					<p className="font-medium text-sm">当前平台能力</p>
					<ul className="mt-2 space-y-2 text-muted-foreground text-xs">
						{pwa.capabilities.map((capability) => (
							<li key={capability.id}>
								{capability.available ? "✓" : "—"} {capability.label}
								{capability.reason !== undefined && `（${capability.reason}）`}
							</li>
						))}
					</ul>
				</div>

				<div className="mt-4">
					<button
						type="button"
						className={smallButtonClass}
						onClick={pwa.checkForUpdate}
					>
						检查更新
					</button>
					{pwa.updateReady && (
						<button
							type="button"
							className={`${buttonClass} ml-2`}
							onClick={pwa.applyUpdate}
						>
							有新版本，立即更新
						</button>
					)}
				</div>
			</section>

			<section className={sectionClass}>
				<h2 className="font-semibold text-xl">备份与安全</h2>
				<p className="mt-2 text-muted-foreground text-sm">
					配置可导出为 JSON
					自行备份。导出默认不包含密钥；密钥只存在本浏览器的独立存储槽中。
				</p>

				<label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
					<input
						type="checkbox"
						id="export-include-keys"
						name="export-include-keys"
						checked={exportIncludeKeys}
						onChange={(event) => setExportIncludeKeys(event.target.checked)}
					/>
					导出时包含 API Key（不推荐，会先二次确认）
				</label>

				<div className="mt-4 flex flex-wrap gap-4">
					<button type="button" className={buttonClass} onClick={runExport}>
						导出配置
					</button>
					<button
						type="button"
						className={
							clearConfirming
								? "rounded-md bg-primary-strong px-4 py-2 text-sm text-primary-foreground"
								: ghostButtonClass
						}
						onClick={clearKeys}
					>
						{clearConfirming ? "确认清除所有密钥？" : "清除所有密钥"}
					</button>
					{clearConfirming && (
						<button
							type="button"
							className={ghostButtonClass}
							onClick={() => setClearConfirming(false)}
						>
							取消
						</button>
					)}
				</div>

				{store.connections.length > 0 && (
					<p className="mt-4 text-muted-foreground text-xs">
						当前已保存密钥：
						{store.connections
							.filter((connection) => store.hasKey(connection.id))
							.map(
								(connection) =>
									`${connection.name} ${maskSecret(store.keyFor(connection.id))}`,
							)
							.join("、") || "（无）"}
					</p>
				)}
			</section>
		</>
	);
}
