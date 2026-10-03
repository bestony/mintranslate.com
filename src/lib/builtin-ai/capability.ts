/**
 * Capability and readiness checks for Chrome Built-in AI.
 *
 * Availability queries are injected in tests and only call browser-provided
 * APIs. They never issue a fetch or otherwise create an application request.
 */

import type { ConnectionStatus } from "../connections/model";
import { isPromptApiLanguage } from "./languages";

/** Normalized values returned by the three browser APIs. */
export const BUILTIN_AVAILABILITIES = [
	"unavailable",
	"downloadable",
	"downloading",
	"available",
] as const;

export type BuiltinAvailability = (typeof BUILTIN_AVAILABILITIES)[number];

/** Why an API may be unavailable on the current device. */
export type BuiltinUnavailableReason =
	| "browser"
	| "language-pair"
	| "device"
	| "unknown";

/** A normalized readiness result with an optional user-facing reason. */
export interface BuiltinReadiness {
	readonly state: BuiltinAvailability;
	readonly reason?: BuiltinUnavailableReason;
}

/** Minimum Translator session surface used by this application. */
export interface BuiltinTranslatorSession {
	translate(
		input: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<string>;
	translateStreaming(
		input: string,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<string>;
	close?(): void;
}

/** Minimum Translator constructor surface used by this application. */
export interface BuiltinTranslatorApi {
	availability(options: {
		readonly sourceLanguage: string;
		readonly targetLanguage: string;
	}): Promise<unknown> | unknown;
	create(options: {
		readonly sourceLanguage: string;
		readonly targetLanguage: string;
		readonly monitor?: (event: { readonly downloadProgress?: number }) => void;
	}): Promise<BuiltinTranslatorSession> | BuiltinTranslatorSession;
}

/** Minimum Language Detector session surface used by this application. */
export interface BuiltinLanguageDetectorSession {
	detect(input: string): Promise<
		readonly {
			readonly detectedLanguage: string;
			readonly confidence: number;
		}[]
	>;
	close?(): void;
}

/** Minimum Language Detector constructor surface used by this application. */
export interface BuiltinLanguageDetectorApi {
	availability?(): Promise<unknown> | unknown;
	create(
		options?: Record<string, unknown>,
	): Promise<BuiltinLanguageDetectorSession> | BuiltinLanguageDetectorSession;
}

/** Minimum Prompt API session surface used by this application. */
export interface BuiltinLanguageModelSession {
	prompt(
		input: unknown,
		options?: {
			readonly signal?: AbortSignal;
			readonly responseConstraint?: unknown;
		},
	): Promise<string>;
	promptStreaming(
		input: unknown,
		options?: {
			readonly signal?: AbortSignal;
			readonly responseConstraint?: unknown;
		},
	): AsyncIterable<string>;
	destroy?(): void;
}

/** Minimum Prompt API constructor surface used by this application. */
export interface BuiltinLanguageModelApi {
	availability(options?: Record<string, unknown>): Promise<unknown> | unknown;
	create(
		options?: Record<string, unknown>,
	): Promise<BuiltinLanguageModelSession> | BuiltinLanguageModelSession;
}

/** The global object shape is intentionally structural for browser and tests. */
export interface BuiltinApiScope {
	readonly Translator?: BuiltinTranslatorApi;
	readonly LanguageDetector?: BuiltinLanguageDetectorApi;
	readonly LanguageModel?: BuiltinLanguageModelApi;
}

/** Presence-only view used by detection, including minimal test doubles. */
export interface BuiltinApiPresenceScope {
	readonly Translator?: unknown;
	readonly LanguageDetector?: unknown;
	readonly LanguageModel?: unknown;
}

/** Presence of each browser capability; no API is called by this function. */
export interface BuiltinCapabilityDetection {
	readonly translator: boolean;
	readonly languageDetector: boolean;
	readonly languageModel: boolean;
}

/** Detect browser API presence without invoking a network or model operation. */
export function detectBuiltinCapabilities(
	scope: BuiltinApiPresenceScope = globalThis as BuiltinApiPresenceScope,
): BuiltinCapabilityDetection {
	return {
		translator: scope.Translator !== undefined,
		languageDetector: scope.LanguageDetector !== undefined,
		languageModel: scope.LanguageModel !== undefined,
	};
}

/** Compatibility alias used by settings and store code. */
export const detectCapabilities = detectBuiltinCapabilities;

/** Normalize a browser availability value; unknown values are unavailable. */
export function normalizeAvailability(value: unknown): BuiltinAvailability {
	return BUILTIN_AVAILABILITIES.includes(value as BuiltinAvailability)
		? (value as BuiltinAvailability)
		: "unavailable";
}

/** Query Translator readiness for one language pair. */
export async function queryTranslatorAvailability(
	sourceLanguage: string,
	targetLanguage: string,
	options: {
		readonly api?: BuiltinTranslatorApi;
		readonly scope?: BuiltinApiScope;
	} = {},
): Promise<BuiltinReadiness> {
	const api =
		options.api ??
		(options.scope ?? (globalThis as BuiltinApiScope)).Translator;
	if (api === undefined) return { state: "unavailable", reason: "browser" };

	try {
		const value = await api.availability({ sourceLanguage, targetLanguage });
		const state = normalizeAvailability(value);
		return state === "unavailable"
			? { state, reason: "language-pair" }
			: { state };
	} catch {
		return { state: "unavailable", reason: "language-pair" };
	}
}

/** Query Prompt API readiness for a target language. */
export async function queryLanguageModelAvailability(
	targetLanguage: string,
	options: {
		readonly api?: BuiltinLanguageModelApi;
		readonly scope?: BuiltinApiScope;
	} = {},
): Promise<BuiltinReadiness> {
	const api =
		options.api ??
		(options.scope ?? (globalThis as BuiltinApiScope)).LanguageModel;
	if (api === undefined) return { state: "unavailable", reason: "browser" };
	if (!isPromptApiLanguage(targetLanguage)) {
		return { state: "unavailable", reason: "language-pair" };
	}

	try {
		const value = await api.availability({
			language: targetLanguage,
			expectedInputs: [{ type: "text" }, { type: "image" }],
			expectedOutputs: [{ type: "text" }],
		});
		const state = normalizeAvailability(value);
		return state === "unavailable" ? { state, reason: "device" } : { state };
	} catch {
		return { state: "unavailable", reason: "device" };
	}
}

/** Whether a target/source language pair can be sent to Prompt API. */
export function validatePromptLanguagePair(options: {
	readonly sourceLanguage?: string;
	readonly targetLanguage: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	if (!isPromptApiLanguage(options.targetLanguage)) {
		return {
			ok: false,
			reason: `内置多模态通道不支持目标语言「${options.targetLanguage}」，请切换到支持该语言的连接。`,
		};
	}
	if (
		options.sourceLanguage !== undefined &&
		options.sourceLanguage !== "auto" &&
		!isPromptApiLanguage(options.sourceLanguage)
	) {
		return {
			ok: false,
			reason: `内置多模态通道不支持源语言「${options.sourceLanguage}」，请切换到支持该语言的连接。`,
		};
	}
	return { ok: true };
}

/** Return a refusal message without creating a model-call intent. */
export function promptLanguageBlocker(
	targetLanguage: string,
	sourceLanguage?: string,
): string | undefined {
	const result = validatePromptLanguagePair({ sourceLanguage, targetLanguage });
	return result.ok ? undefined : result.reason;
}

/** Derive the connection status shown by the existing connection system. */
export function deriveBuiltinConnectionStatus(
	readiness: BuiltinReadiness | BuiltinAvailability,
): { readonly status: ConnectionStatus; readonly statusDetail?: string } {
	const normalized: BuiltinReadiness =
		typeof readiness === "string" ? { state: readiness } : readiness;

	if (normalized.state === "available") return { status: "ok" };

	if (normalized.state === "downloadable") {
		return {
			status: "failed",
			statusDetail: "内置模型需要下载，请点击下载并激活。",
		};
	}

	if (normalized.state === "downloading") {
		return { status: "failed", statusDetail: "内置模型正在下载，请稍候。" };
	}

	const details: Record<BuiltinUnavailableReason, string> = {
		browser: "当前浏览器不支持内置 AI。",
		"language-pair": "当前语言对不支持内置 AI。",
		device: "当前设备条件不满足内置 AI 要求。",
		unknown: "内置 AI 当前不可用。",
	};
	return {
		status: "failed",
		statusDetail: details[normalized.reason ?? "unknown"],
	};
}

/** Compatibility alias for code that names this operation as a derivation. */
export const connectionStatusFromReadiness = deriveBuiltinConnectionStatus;
