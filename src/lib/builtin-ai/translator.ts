/**
 * Main-thread wrapper for the browser Translator and Language Detector APIs.
 *
 * A translator is created only when its model is already available or when the
 * caller explicitly invokes `create` from a user gesture. A normal translation
 * request never starts a downloadable model implicitly.
 */

import {
	type BuiltinApiScope,
	type BuiltinLanguageDetectorApi,
	type BuiltinLanguageDetectorSession,
	type BuiltinReadiness,
	type BuiltinTranslatorApi,
	type BuiltinTranslatorSession,
	queryTranslatorAvailability,
} from "./capability";
import { fromBuiltinCode, toBuiltinCode } from "./languages";

/** A detected source language returned by the local detector. */
export interface BuiltinDetectedLanguage {
	readonly code: string;
	readonly confidence: number;
	readonly lowConfidence: boolean;
	/** True when Chrome's `zh` result cannot distinguish Chinese variants. */
	readonly ambiguousChinese?: boolean;
}

/** Progress callback forwarded from a browser model monitor. */
export type DownloadProgress = (progress: number) => void;

/** Options accepted by a translation call. */
export interface BuiltinTranslateOptions {
	readonly signal?: AbortSignal;
	readonly onChunk?: (delta: string) => void;
}

/** Error raised when a request needs an explicit model activation. */
export class BuiltinTranslatorNotReadyError extends Error {
	readonly readiness: BuiltinReadiness;

	constructor(readiness: BuiltinReadiness) {
		super(
			readiness.state === "downloadable"
				? "内置翻译模型需要用户点击后下载。"
				: readiness.state === "downloading"
					? "内置翻译模型正在下载。"
					: "内置翻译模型当前不可用。",
		);
		this.name = "BuiltinTranslatorNotReadyError";
		this.readiness = readiness;
	}
}

/** Error raised when local detection cannot select a trustworthy language. */
export class BuiltinLanguageDetectionError extends Error {
	constructor(message = "无法确定源语言，请手动指定。") {
		super(message);
		this.name = "BuiltinLanguageDetectionError";
	}
}

/** Error raised when a browser call is cancelled. */
export class BuiltinTranslationCancelledError extends Error {
	constructor() {
		super("内置翻译已取消");
		this.name = "BuiltinTranslationCancelledError";
	}
}

/** A reusable main-thread Translator client. */
export interface BuiltinTranslatorClient {
	availability(
		sourceLanguage: string,
		targetLanguage: string,
	): Promise<BuiltinReadiness>;
	/** Explicitly create/download a translator after a user gesture. */
	create(
		sourceLanguage: string,
		targetLanguage: string,
		options?: { readonly onProgress?: DownloadProgress },
	): Promise<void>;
	translate(
		sourceLanguage: string,
		targetLanguage: string,
		input: string,
		options?: BuiltinTranslateOptions,
	): Promise<{
		readonly text: string;
		readonly detectedLang?: BuiltinDetectedLanguage;
	}>;
	translateStreaming(
		sourceLanguage: string,
		targetLanguage: string,
		input: string,
		options?: BuiltinTranslateOptions,
	): Promise<{
		readonly text: string;
		readonly detectedLang?: BuiltinDetectedLanguage;
	}>;
	detect(
		input: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<BuiltinDetectedLanguage>;
	destroy(sourceLanguage: string, targetLanguage: string): void;
}

interface TranslatorEntry {
	readonly sourceLanguage: string;
	readonly targetLanguage: string;
	readonly session: BuiltinTranslatorSession;
}

interface DetectorEntry {
	readonly session: BuiltinLanguageDetectorSession;
}

/** Translate a Chrome monitor event into a numeric progress value. */
function progressFromEvent(event: unknown): number | undefined {
	if (typeof event === "number") return event;
	if (typeof event !== "object" || event === null) return undefined;
	const value = (event as { readonly downloadProgress?: unknown })
		.downloadProgress;
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, Math.min(1, value))
		: undefined;
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new BuiltinTranslationCancelledError();
}

function signalOptions(signal: AbortSignal | undefined): {
	signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
}

/** Create a reusable Translator/Language Detector client. */
export function createBuiltinTranslatorClient(
	options: {
		readonly api?: BuiltinTranslatorApi;
		readonly detectorApi?: BuiltinLanguageDetectorApi;
		readonly scope?: BuiltinApiScope;
		readonly onDownloadProgress?: DownloadProgress;
	} = {},
): BuiltinTranslatorClient {
	const scope = options.scope ?? (globalThis as BuiltinApiScope);
	const api = options.api ?? scope.Translator;
	const detectorApi = options.detectorApi ?? scope.LanguageDetector;
	const translators = new Map<string, TranslatorEntry>();
	let detector: DetectorEntry | undefined;

	function key(sourceLanguage: string, targetLanguage: string): string {
		return `${sourceLanguage}\u0000${targetLanguage}`;
	}

	async function availability(
		sourceLanguage: string,
		targetLanguage: string,
	): Promise<BuiltinReadiness> {
		const source = toBuiltinCode(sourceLanguage);
		const target = toBuiltinCode(targetLanguage);
		if (source === undefined || target === undefined || api === undefined) {
			return { state: "unavailable", reason: "browser" };
		}
		return queryTranslatorAvailability(source, target, { api });
	}

	async function create(
		sourceLanguage: string,
		targetLanguage: string,
		createOptions: { readonly onProgress?: DownloadProgress } = {},
	): Promise<void> {
		const source = toBuiltinCode(sourceLanguage);
		const target = toBuiltinCode(targetLanguage);
		if (source === undefined || target === undefined || api === undefined) {
			throw new BuiltinTranslatorNotReadyError({
				state: "unavailable",
				reason: "language-pair",
			});
		}

		const monitor = (event: unknown) => {
			const progress = progressFromEvent(event);
			if (progress === undefined) return;
			createOptions.onProgress?.(progress);
			options.onDownloadProgress?.(progress);
		};
		const session = await api.create({
			sourceLanguage: source,
			targetLanguage: target,
			monitor,
		});
		translators.set(key(sourceLanguage, targetLanguage), {
			sourceLanguage,
			targetLanguage,
			session,
		});
	}

	async function ensureSession(
		sourceLanguage: string,
		targetLanguage: string,
	): Promise<TranslatorEntry> {
		const existing = translators.get(key(sourceLanguage, targetLanguage));
		if (existing) return existing;

		const readiness = await availability(sourceLanguage, targetLanguage);
		if (readiness.state !== "available")
			throw new BuiltinTranslatorNotReadyError(readiness);
		await create(sourceLanguage, targetLanguage);
		const created = translators.get(key(sourceLanguage, targetLanguage));
		if (created === undefined)
			throw new BuiltinTranslatorNotReadyError({
				state: "unavailable",
				reason: "unknown",
			});
		return created;
	}

	async function ensureDetector(): Promise<BuiltinLanguageDetectorSession> {
		if (detector) return detector.session;
		if (detectorApi === undefined)
			throw new BuiltinLanguageDetectionError("当前浏览器不支持本地语言检测。");
		detector = { session: await detectorApi.create() };
		return detector.session;
	}

	async function detect(
		input: string,
		detectOptions: { readonly signal?: AbortSignal } = {},
	): Promise<BuiltinDetectedLanguage> {
		abortIfNeeded(detectOptions.signal);
		const session = await ensureDetector();
		const results = await session.detect(input);
		abortIfNeeded(detectOptions.signal);
		const best = results
			.filter(
				(result) =>
					typeof result.detectedLanguage === "string" &&
					typeof result.confidence === "number" &&
					Number.isFinite(result.confidence),
			)
			.sort((a, b) => b.confidence - a.confidence)[0];
		if (best === undefined || best.confidence < 0.5) {
			throw new BuiltinLanguageDetectionError();
		}
		const code = fromBuiltinCode(best.detectedLanguage);
		if (code === undefined) throw new BuiltinLanguageDetectionError();
		return {
			code,
			confidence: best.confidence,
			lowConfidence: best.confidence < 0.75,
			...(best.detectedLanguage === "zh" && { ambiguousChinese: true }),
		};
	}

	async function translate(
		sourceLanguage: string,
		targetLanguage: string,
		input: string,
		translateOptions: BuiltinTranslateOptions = {},
	): Promise<{
		readonly text: string;
		readonly detectedLang?: BuiltinDetectedLanguage;
	}> {
		abortIfNeeded(translateOptions.signal);
		let concreteSource = sourceLanguage;
		let detectedLang: BuiltinDetectedLanguage | undefined;
		if (sourceLanguage === "auto") {
			detectedLang = await detect(input, { signal: translateOptions.signal });
			concreteSource = detectedLang.code;
		}
		const entry = await ensureSession(concreteSource, targetLanguage);
		try {
			const text = await entry.session.translate(
				input,
				signalOptions(translateOptions.signal),
			);
			abortIfNeeded(translateOptions.signal);
			return { text, ...(detectedLang !== undefined && { detectedLang }) };
		} catch (error) {
			if (translateOptions.signal?.aborted)
				throw new BuiltinTranslationCancelledError();
			throw error;
		}
	}

	async function translateStreaming(
		sourceLanguage: string,
		targetLanguage: string,
		input: string,
		translateOptions: BuiltinTranslateOptions = {},
	): Promise<{
		readonly text: string;
		readonly detectedLang?: BuiltinDetectedLanguage;
	}> {
		abortIfNeeded(translateOptions.signal);
		let concreteSource = sourceLanguage;
		let detectedLang: BuiltinDetectedLanguage | undefined;
		if (sourceLanguage === "auto") {
			detectedLang = await detect(input, { signal: translateOptions.signal });
			concreteSource = detectedLang.code;
		}
		const entry = await ensureSession(concreteSource, targetLanguage);
		let text = "";
		try {
			for await (const chunk of entry.session.translateStreaming(
				input,
				signalOptions(translateOptions.signal),
			)) {
				abortIfNeeded(translateOptions.signal);
				text += chunk;
				translateOptions.onChunk?.(chunk);
			}
			return { text, ...(detectedLang !== undefined && { detectedLang }) };
		} catch (error) {
			if (translateOptions.signal?.aborted)
				throw new BuiltinTranslationCancelledError();
			throw error;
		}
	}

	return {
		availability,
		create,
		translate,
		translateStreaming,
		detect,
		destroy(sourceLanguage, targetLanguage) {
			const entry = translators.get(key(sourceLanguage, targetLanguage));
			entry?.session.close?.();
			translators.delete(key(sourceLanguage, targetLanguage));
		},
	};
}

/** Short factory alias used by call sites that mirror the browser API name. */
export const createTranslator = createBuiltinTranslatorClient;
