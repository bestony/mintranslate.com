/**
 * Connection form for a single connection.
 *
 * Holds the create/edit form: provider preset picker, the three fields
 * (endpoint, model, key), the capability toggles, the tier assignment and the
 * connection test.
 *
 * The key is held in local component state and handed to the store on change.
 * It is never rendered in clear by default: the input is masked until the user
 * explicitly reveals it, and the revealed state is deliberately not persisted
 * (spec `credential-storage`).
 */

import { useEffect, useMemo, useState } from "react";
import { createAnalytics } from "#/lib/analytics/track";
import { describeWait } from "#/lib/call-control/backoff";
import { intranetHint } from "#/lib/connections/intranet-hint";
import type {
	Connection,
	ConnectionEdit,
	ModelTier,
	ProviderId,
} from "#/lib/connections/model";
import { PROVIDER_IDS } from "#/lib/connections/model";
import { PROVIDER_PRESETS, presetFor } from "#/lib/connections/presets";
import { CONNECTION_TEST_TIMEOUT_MS } from "#/lib/connections/test-connection";
import type {
	createConnectionTestController,
	TestRefusal,
} from "#/lib/connections/test-controller";
import { maskSecret } from "#/lib/credentials/redact";

interface ConnectionFormProps {
	readonly connection: Connection;
	readonly apiKey: string;
	readonly onChange: (edit: ConnectionEdit) => void;
	readonly onProviderChange: (provider: ProviderId) => void;
	readonly onKeyChange: (key: string) => void;
	readonly onTested: (status: "ok" | "failed", detail?: string) => void;
	/**
	 * Pacing controller for connection tests. Owned by the parent so switching or
	 * deleting a connection can abort an in-flight test for it.
	 */
	readonly testController: ReturnType<typeof createConnectionTestController>;
}

/** Badge for the direct-connect verification status. */
function DirectConnectBadge({ provider }: { readonly provider: ProviderId }) {
	const preset = presetFor(provider);
	if (!preset) return null;

	const verified = preset.directConnect === "verified";
	return (
		<span
			className={
				verified
					? "rounded-sm border border-border bg-surface px-2 text-xs"
					: "rounded-sm border border-border bg-surface px-2 text-xs "
			}
		>
			{verified ? "已验证可直连" : "需自行测试"}
		</span>
	);
}

/**
 * Pre-flight conditions for a self-hosted endpoint.
 *
 * The page origin is resolved after mount: the prerender has no `location`, and
 * reading it during render would make the first client render disagree with the
 * shell (see the hydration suite). Nothing here depends on a test result, so the
 * notice is visible from the moment the endpoint is typed.
 */
function EndpointConditionsNotice({
	provider,
	endpoint,
}: {
	readonly provider: ProviderId;
	readonly endpoint: string;
}) {
	const [pageUrl, setPageUrl] = useState<string | undefined>(undefined);

	useEffect(() => {
		setPageUrl(window.location.href);
	}, []);

	const hint = intranetHint({ provider, endpoint, pageUrl });
	if (!hint.show) return null;

	return (
		<div className="rounded-md border border-border bg-surface p-4 text-xs md:col-span-2">
			<p className="font-medium">内网自建模型的接入前提</p>
			<ul className="mt-2 list-disc space-y-2 pl-6 text-muted-foreground">
				{hint.conditions.map((condition) => (
					<li key={condition}>{condition}</li>
				))}
			</ul>
			{/* A document reference, not a link: the deployment guide is a file in the
			    repository that this application does not serve, so an in-app link would
			    be a dead end. Naming the section is what a deployer can act on. */}
			<p className="mt-2 text-muted-foreground">
				各推理框架（Ollama / vLLM / LM Studio / Nginx
				反代）的放行配置与自查命令见 部署文档的「{hint.docsSection}」一节。
			</p>
		</div>
	);
}

export function ConnectionForm({
	connection,
	apiKey,
	onChange,
	onProviderChange,
	onKeyChange,
	onTested,
	testController,
}: ConnectionFormProps) {
	const [revealKey, setRevealKey] = useState(false);
	/** Analytics entry point for configuration and connection-test events. */
	const analytics = useMemo(
		() => createAnalytics({ byokConfigured: () => true }),
		[],
	);
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<
		| { ok: true; latencyMs: number }
		| { ok: false; text: string; checklist?: readonly string[] }
		| undefined
	>(undefined);

	const preset = presetFor(connection.provider);
	const labelClass = "mt-2 block font-medium text-sm";
	// `min-h-11` gives every text field a 44px touch target. Focus styling is left
	// to the global `:focus-visible` ring: overriding it with a border colour
	// change made focus depend on colour alone.
	const inputClass =
		"mt-2 min-h-11 w-full rounded-md border border-input bg-background px-4 text-sm";

	/** Message for a refusal, so the user learns why nothing happened. */
	function refusalMessage(refusal: TestRefusal): string {
		return refusal.kind === "in-progress"
			? "该连接正在测试中，请稍候。"
			: `刚测试过，请等待约 ${Math.ceil(refusal.remainingMs / 1000)} 秒后再试。`;
	}

	async function runTest() {
		setTesting(true);
		setResult(undefined);
		try {
			const outcome = await testController.request(connection, apiKey);

			if (outcome.kind === "refused") {
				setResult({ ok: false, text: refusalMessage(outcome.refusal) });
				return;
			}

			const { result: outcomeResult } = outcome;
			if (outcomeResult.ok) {
				setResult({ ok: true, latencyMs: outcomeResult.latencyMs });
				onTested("ok");
				analytics.track("connection_test", {
					provider: connection.provider,
					success: true,
					error_type: "unknown",
					latency_ms: outcomeResult.latencyMs,
				});
				return;
			}

			analytics.track("connection_test", {
				provider: connection.provider,
				success: false,
				error_type: outcomeResult.attribution.type,
				latency_ms: outcomeResult.latencyMs,
			});

			const lines = [outcomeResult.attribution.summary];

			// A rate-limited endpoint tells us how long to wait; show that instead
			// of making the user guess.
			if (outcomeResult.attribution.type === "rate_limit_429") {
				lines.push(describeWait(outcomeResult.suggestedWaitMs ?? 1000));
			}

			if (outcomeResult.diagnostic)
				lines.push(`诊断：${outcomeResult.diagnostic}`);

			setResult({
				ok: false,
				text: lines.join("\n"),
				...(outcomeResult.attribution.checklist && {
					checklist: outcomeResult.attribution.checklist,
				}),
			});
			onTested("failed", outcomeResult.attribution.type);
		} finally {
			setTesting(false);
		}
	}

	return (
		<div className="island-shell rounded-md p-6">
			<div className="flex flex-wrap items-center gap-4">
				<h3 className="font-semibold text-lg">{connection.name}</h3>
				<DirectConnectBadge provider={connection.provider} />
				<span className="text-muted-foreground text-xs">
					状态：
					{connection.status === "ok"
						? "已通过测试"
						: connection.status === "testing"
							? "测试中"
							: connection.status === "failed"
								? `未通过（${connection.statusDetail ?? "未知原因"}）`
								: "未测试"}
				</span>
			</div>

			<div className="mt-4 grid gap-4 md:grid-cols-2">
				<label className="block">
					<span className={labelClass}>服务商</span>
					<select
						id="connection-provider"
						name="provider"
						className={inputClass}
						value={connection.provider}
						onChange={(event) =>
							onProviderChange(event.target.value as ProviderId)
						}
					>
						{PROVIDER_IDS.map((id) => (
							<option key={id} value={id}>
								{presetFor(id)?.label ?? id}
							</option>
						))}
					</select>
				</label>

				<label className="block">
					<span className={labelClass}>名称</span>
					<input
						id="connection-name"
						name="connection-name"
						className={inputClass}
						value={connection.name}
						onChange={(event) => onChange({ name: event.target.value })}
					/>
				</label>

				<label className="block">
					<span className={labelClass}>Endpoint（Base URL）</span>
					<input
						id="connection-endpoint"
						name="connection-endpoint"
						className={inputClass}
						value={connection.endpoint}
						placeholder={preset?.endpoint || "https://your-endpoint/v1"}
						onChange={(event) => onChange({ endpoint: event.target.value })}
					/>
				</label>

				{/* Shown before a test is run, so the conditions are known before the
				    user meets the opaque failure the browser would give. */}
				<EndpointConditionsNotice
					provider={connection.provider}
					endpoint={connection.endpoint}
				/>

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
						{preset?.models.map((model) => (
							<option key={model} value={model} />
						))}
					</datalist>
				</label>

				<label className="block md:col-span-2">
					<span className={labelClass}>API Key</span>
					<div className="flex gap-2">
						<input
							id="connection-api-key"
							name="connection-api-key"
							className={inputClass}
							type={revealKey ? "text" : "password"}
							value={apiKey}
							autoComplete="off"
							placeholder={apiKey === "" ? "" : maskSecret(apiKey)}
							onChange={(event) => onKeyChange(event.target.value)}
						/>
						<button
							type="button"
							className="mt-2 shrink-0 rounded-md border border-input min-h-11 px-4 text-sm"
							onClick={() => setRevealKey((current) => !current)}
						>
							{revealKey ? "隐藏" : "显示"}
						</button>
					</div>
					{!revealKey && apiKey !== "" && (
						<span className="mt-2 block text-muted-foreground text-xs">
							当前：{maskSecret(apiKey)}
						</span>
					)}
				</label>
			</div>

			<p className="mt-4 text-muted-foreground text-xs">
				密钥只保存在本浏览器。BYOK 直连模式下，密钥会随请求直接发往你填写的
				Endpoint，请勿在公共或共享设备上保存密钥。
			</p>

			{connection.provider === "anthropic" && (
				<p className="mt-2 text-muted-foreground text-xs">
					Anthropic
					为浏览器直连提供了官方开关，应用已按官方方式开启，无需你手动配置。
				</p>
			)}

			<div className="mt-4 flex flex-wrap items-center gap-4">
				<div className="flex gap-4 text-sm">
					<label className="flex min-h-11 items-center gap-2">
						<input
							type="checkbox"
							id="capability-text"
							name="capability-text"
							checked={connection.capabilities.text}
							onChange={(event) =>
								onChange({
									capabilities: {
										...connection.capabilities,
										text: event.target.checked,
									},
								})
							}
						/>
						文本
					</label>
					<label className="flex min-h-11 items-center gap-2">
						<input
							type="checkbox"
							id="capability-vision"
							name="capability-vision"
							checked={connection.capabilities.vision}
							onChange={(event) =>
								onChange({
									capabilities: {
										...connection.capabilities,
										vision: event.target.checked,
									},
								})
							}
						/>
						多模态（视觉）
					</label>
				</div>

				<label className="flex min-h-11 items-center gap-2 text-sm">
					档位
					<select
						id="connection-capabilities"
						name="connection-capabilities"
						className="min-h-11 rounded-md border border-input bg-background px-4 text-sm"
						value={connection.tier ?? ""}
						onChange={(event) => {
							const value = event.target.value;
							onChange({
								tier: value === "" ? undefined : (value as ModelTier),
							});
						}}
					>
						<option value="">自动</option>
						<option value="advanced">高级</option>
						<option value="fast">快速</option>
					</select>
				</label>
			</div>

			<div className="mt-4">
				<button
					type="button"
					className="min-h-11 rounded-md bg-primary-strong px-4 text-primary-foreground text-sm disabled:opacity-50"
					disabled={
						testing ||
						connection.endpoint.trim() === "" ||
						connection.model.trim() === ""
					}
					onClick={runTest}
				>
					{testing ? "测试中…" : "测试连接"}
				</button>
				<span className="ml-4 text-muted-foreground text-xs">
					最长等待 {CONNECTION_TEST_TIMEOUT_MS / 1000}{" "}
					秒；测试会产生一次极小的真实调用。
				</span>
			</div>

			{result && (
				<div
					className={
						result.ok
							? "mt-4 rounded-md border border-border bg-surface p-4 text-sm"
							: "mt-4 rounded-md border border-border bg-surface p-4 text-sm"
					}
				>
					{result.ok ? (
						<p>连接成功，耗时 {result.latencyMs} ms。</p>
					) : (
						<>
							<p className="whitespace-pre-wrap">{result.text}</p>
							{result.checklist && (
								<ul className="mt-2 list-disc space-y-2 pl-6">
									{result.checklist.map((item) => (
										<li key={item}>{item}</li>
									))}
								</ul>
							)}
						</>
					)}
				</div>
			)}
		</div>
	);
}

/** Provider preset summary list, used above the form. */
export function PresetHint() {
	return (
		<p className="text-muted-foreground text-sm">
			可选预设：
			{PROVIDER_PRESETS.map((preset) => preset.label).join("、")}
			。选择预设会自动填入 Endpoint 与常见模型，你只需补充 API Key。
		</p>
	);
}
