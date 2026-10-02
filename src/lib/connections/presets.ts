/**
 * Provider presets.
 *
 * A preset fills in the endpoint and suggests models so the user only has to
 * add a key. `directConnect` records whether browser direct-connect has been
 * verified for that endpoint — the UI must distinguish "verified" from "you
 * will have to test this yourself", so this is data rather than a guess at
 * render time.
 *
 * Verification status follows the compatibility matrix measured for the PRD
 * (FR-MODEL-02, 2026-10-02). An endpoint that is not listed as verified is
 * reported as `unverified`, never as working.
 */

import type { ConnectionCapabilities, ProviderId } from "./model";

/** How the browser-direct-connect situation is known. */
export type DirectConnectStatus = "verified" | "unverified";

/** How a preset authenticates. Ollama and self-hosted setups often need none. */
export type KeyRequirement = "required" | "optional";

export interface ProviderPreset {
	readonly provider: ProviderId;
	/** Shown in the preset picker and used for the default connection name. */
	readonly label: string;
	/** Default endpoint. Empty for `custom`, which must stay blank. */
	readonly endpoint: string;
	/** Suggested model ids, most common first. */
	readonly models: readonly string[];
	readonly directConnect: DirectConnectStatus;
	readonly keyRequirement: KeyRequirement;
	/** Capability defaults for a connection created from this preset. */
	readonly capabilities: ConnectionCapabilities;
	/**
	 * Why direct-connect is unverified, shown next to the badge. Only present
	 * for `unverified` presets so the UI cannot imply a guarantee.
	 */
	readonly note?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		provider: "openai",
		label: "OpenAI",
		endpoint: "https://api.openai.com/v1",
		models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
		directConnect: "verified",
		keyRequirement: "required",
		capabilities: { text: true, vision: true },
	},
	{
		provider: "anthropic",
		label: "Anthropic",
		endpoint: "https://api.anthropic.com",
		models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
		directConnect: "verified",
		keyRequirement: "required",
		capabilities: { text: true, vision: true },
		// Browser access is an official Anthropic mechanism, not a workaround;
		// the adapter enables it, so the user never configures it.
	},
	{
		provider: "gemini",
		label: "Google Gemini",
		endpoint: "https://generativelanguage.googleapis.com",
		models: ["gemini-2.5-flash", "gemini-2.5-pro"],
		directConnect: "verified",
		keyRequirement: "required",
		capabilities: { text: true, vision: true },
	},
	{
		provider: "deepseek",
		label: "DeepSeek",
		endpoint: "https://api.deepseek.com/v1",
		models: ["deepseek-chat", "deepseek-reasoner"],
		directConnect: "unverified",
		keyRequirement: "required",
		capabilities: { text: true, vision: false },
		note: "浏览器直连未经验证，请先用「测试连接」确认。",
	},
	{
		provider: "openrouter",
		label: "OpenRouter",
		endpoint: "https://openrouter.ai/api/v1",
		models: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5"],
		directConnect: "verified",
		keyRequirement: "required",
		capabilities: { text: true, vision: true },
	},
	{
		provider: "ollama",
		label: "Ollama",
		endpoint: "http://localhost:11434",
		models: ["llama3.2", "qwen2.5", "llava"],
		directConnect: "verified",
		keyRequirement: "optional",
		capabilities: { text: true, vision: false },
		note: "需要以 OLLAMA_ORIGINS 允许本应用来源，否则浏览器请求会被拒绝。",
	},
	{
		provider: "custom",
		label: "自定义（OpenAI 兼容）",
		endpoint: "",
		models: [],
		directConnect: "unverified",
		keyRequirement: "optional",
		capabilities: { text: true, vision: false },
		note: "自定义端点行为不可预判，必须通过「测试连接」验证后才能使用。",
	},
];

/** Look up a preset by provider id. */
export function presetFor(provider: ProviderId): ProviderPreset | undefined {
	return PROVIDER_PRESETS.find((preset) => preset.provider === provider);
}

/**
 * Fields a preset fills in.
 *
 * `custom` deliberately returns empty values so selecting it does not
 * pre-populate an endpoint the user did not choose.
 */
export function presetDefaults(provider: ProviderId): {
	endpoint: string;
	models: readonly string[];
	capabilities: ConnectionCapabilities;
} {
	const preset = presetFor(provider);
	return {
		endpoint: preset?.endpoint ?? "",
		models: preset?.models ?? [],
		capabilities: preset?.capabilities ?? { text: true, vision: false },
	};
}
