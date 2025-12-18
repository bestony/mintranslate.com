import { type AIAdapter, chat } from "@tanstack/ai";
import { createAnthropic } from "@tanstack/ai-anthropic";
import { createGemini } from "@tanstack/ai-gemini";
import { createOllama } from "@tanstack/ai-ollama";
import { createOpenAI } from "@tanstack/ai-openai";
import { Store } from "@tanstack/react-store";

import { addTranslateHistory } from "@/db/translateHistoryCollection";
import { I18N_KEY_PREFIX } from "@/lib/app-i18n";

let appSettingsModulePromise: Promise<
	typeof import("@/db/appSettingsCollection")
> | null = null;

function loadAppSettingsModule() {
	appSettingsModulePromise ??= import("@/db/appSettingsCollection");
	return appSettingsModulePromise;
}

export type Lang = "zh" | "en" | "fr" | "ja" | "es";

export const TRANSLATE_LANGS = [
	"zh",
	"en",
	"fr",
	"ja",
	"es",
] as const satisfies readonly Lang[];

export type ProviderType = "openai" | "anthropic" | "gemini" | "ollama";

export type AIProvider = {
	id: string;
	type: ProviderType;
	name: string;
	apiKey?: string;
	baseUrl?: string;
	model: string;
};

export type TranslateState = {
	providers: AIProvider[];
	defaultProviderId: string;

	systemPrompt: string;

	leftLang: Lang;
	rightLang: Lang;
	leftText: string;
	rightText: string;

	isTranslating: boolean;
	translateError: string;
	debouncedLeftText: string;
};

export const AI_PROVIDERS_STORAGE_KEY = "mintranslate.aiProviders";
export const AI_DEFAULT_PROVIDER_ID_STORAGE_KEY =
	"mintranslate.aiDefaultProviderId";
export const LEGACY_GEMINI_API_KEY_STORAGE_KEY = "mintranslate.geminiApiKey";
export const TRANSLATE_LANG_PAIR_STORAGE_KEY = "mintranslate.translateLangPair";

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderType, string> = {
	openai: "gpt-4.1-mini",
	anthropic: "claude-3-5-haiku",
	gemini: "gemini-2.5-flash",
	ollama: "llama3",
};

const TRANSLATE_DEBOUNCE_MS = 500;

const langLabel: Record<Lang, string> = {
	zh: "中文",
	en: "英文",
	fr: "法语",
	ja: "日语",
	es: "西班牙语",
};

export const DEFAULT_SYSTEM_PROMPT = [
	"你是一个翻译引擎。",
	"你会将用户输入的文本从指定语言翻译成目标语言。",
	"要求：",
	"1) 只输出译文，不要解释，不要加引号，不要添加额外内容。",
	"2) 保留原文的换行与格式。",
].join("\n");

export const translateStore = new Store<TranslateState>({
	providers: [],
	defaultProviderId: "",

	systemPrompt: DEFAULT_SYSTEM_PROMPT,

	leftLang: "zh",
	rightLang: "en",
	leftText: "",
	rightText: "",

	isTranslating: false,
	translateError: "",
	debouncedLeftText: "",
});

export function patchTranslateState(patch: Partial<TranslateState>) {
	translateStore.setState((state) => {
		return {
			...state,
			...patch,
		};
	});
}

function createProviderId() {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}

	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isTranslateLang(value: unknown): value is Lang {
	return TRANSLATE_LANGS.includes(value as Lang);
}

function persistTranslateLangPair(sourceLang: Lang, targetLang: Lang) {
	if (sourceLang === targetLang) return;
	try {
		globalThis.localStorage?.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang, targetLang }),
		);
	} catch {
		// ignore
	}
}

function requiresApiKey(providerType: ProviderType) {
	return providerType !== "ollama";
}

function getActiveProvider(state: TranslateState) {
	if (!state.defaultProviderId) return null;
	return state.providers.find((p) => p.id === state.defaultProviderId) ?? null;
}

function persistProviderSettings(
	nextProviders: AIProvider[],
	nextDefaultId: string,
) {
	globalThis.localStorage?.setItem(
		AI_PROVIDERS_STORAGE_KEY,
		JSON.stringify(nextProviders),
	);
	globalThis.localStorage?.setItem(
		AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
		nextDefaultId,
	);
}

function parseProvidersFromStorage(raw: string | null): AIProvider[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];

		return parsed
			.map((item) => {
				if (!item || typeof item !== "object") return null;
				const obj = item as Record<string, unknown>;
				const id = typeof obj.id === "string" ? obj.id : "";
				const type =
					obj.type === "openai" ||
					obj.type === "anthropic" ||
					obj.type === "gemini" ||
					obj.type === "ollama"
						? obj.type
						: null;
				const name = typeof obj.name === "string" ? obj.name : "";
				const model = typeof obj.model === "string" ? obj.model : "";
				const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : undefined;
				const baseUrl =
					typeof obj.baseUrl === "string" ? obj.baseUrl : undefined;

				if (!id || !type || !name || !model) return null;

				const provider: AIProvider = {
					id,
					type,
					name,
					model,
					apiKey,
					baseUrl,
				};
				return provider;
			})
			.filter((item): item is AIProvider => Boolean(item));
	} catch {
		return [];
	}
}

function parseTranslateLangPairFromStorage(raw: string | null): {
	sourceLang: Lang;
	targetLang: Lang;
} | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		const sourceLang = obj.sourceLang;
		const targetLang = obj.targetLang;
		if (!isTranslateLang(sourceLang) || !isTranslateLang(targetLang))
			return null;
		if (sourceLang === targetLang) return null;
		return { sourceLang, targetLang };
	} catch {
		return null;
	}
}

export function hydrateProviderSettingsFromStorage() {
	const storedProviders = parseProvidersFromStorage(
		globalThis.localStorage?.getItem(AI_PROVIDERS_STORAGE_KEY) ?? null,
	);
	const storedDefaultId =
		globalThis.localStorage?.getItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY) ?? "";

	translateStore.setState((state) => {
		let nextProviders = storedProviders;
		let nextDefaultId = storedDefaultId;

		if (!nextDefaultId) {
			nextDefaultId = nextProviders[0]?.id ?? "";
		}

		if (nextDefaultId && !nextProviders.some((p) => p.id === nextDefaultId)) {
			nextDefaultId = nextProviders[0]?.id ?? "";
		}

		if (!nextProviders.length) {
			const legacyKey =
				globalThis.localStorage?.getItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY) ??
				"";
			if (legacyKey.trim()) {
				const migrated: AIProvider = {
					id: createProviderId(),
					type: "gemini",
					name: "Gemini",
					apiKey: legacyKey.trim(),
					model: DEFAULT_MODEL_BY_PROVIDER.gemini,
				};
				nextProviders = [migrated];
				nextDefaultId = migrated.id;
				persistProviderSettings(nextProviders, nextDefaultId);
			}
		}

		return {
			...state,
			providers: nextProviders,
			defaultProviderId: nextDefaultId,
		};
	});
}

export function hydrateTranslateLangPairFromStorage() {
	const storedPair = parseTranslateLangPairFromStorage(
		globalThis.localStorage?.getItem(TRANSLATE_LANG_PAIR_STORAGE_KEY) ?? null,
	);
	if (!storedPair) return;

	translateStore.setState((state) => {
		if (
			state.leftLang === storedPair.sourceLang &&
			state.rightLang === storedPair.targetLang
		) {
			return state;
		}

		return {
			...state,
			leftLang: storedPair.sourceLang,
			rightLang: storedPair.targetLang,
			debouncedLeftText: state.leftText,
		};
	});
}

export function setDefaultProvider(providerId: string) {
	translateStore.setState((state) => {
		if (state.defaultProviderId === providerId) return state;
		if (!state.providers.some((p) => p.id === providerId)) return state;
		persistProviderSettings(state.providers, providerId);
		return { ...state, defaultProviderId: providerId };
	});
}

export function deleteProvider(providerId: string) {
	translateStore.setState((state) => {
		const nextProviders = state.providers.filter((p) => p.id !== providerId);
		let nextDefaultId = state.defaultProviderId;
		if (nextDefaultId === providerId) {
			nextDefaultId = nextProviders[0]?.id ?? "";
		}

		persistProviderSettings(nextProviders, nextDefaultId);

		return {
			...state,
			providers: nextProviders,
			defaultProviderId: nextDefaultId,
		};
	});
}

export type ProviderFormValues = {
	id?: string;
	type: ProviderType;
	name: string;
	model: string;
	apiKey: string;
	baseUrl: string;
};

export type ProviderFormErrorKey =
	| "errors.providerNameRequired"
	| "errors.modelRequired"
	| "errors.apiKeyRequired";

export function saveProviderFromForm(values: ProviderFormValues): {
	error: ProviderFormErrorKey | null;
	providerId?: string;
} {
	const providerType = values.type;
	const name = values.name.trim();
	const model = values.model.trim();
	const apiKey = values.apiKey.trim();
	const baseUrl = values.baseUrl.trim();

	if (!name) return { error: "errors.providerNameRequired" };
	if (!model) return { error: "errors.modelRequired" };
	if (requiresApiKey(providerType) && !apiKey)
		return { error: "errors.apiKeyRequired" };

	const id = values.id ?? createProviderId();
	const provider: AIProvider = {
		id,
		type: providerType,
		name,
		model,
		apiKey: apiKey || undefined,
		baseUrl: baseUrl || undefined,
	};

	translateStore.setState((state) => {
		const exists = state.providers.some((p) => p.id === id);
		const nextProviders = exists
			? state.providers.map((p) => (p.id === id ? provider : p))
			: [...state.providers, provider];

		let nextDefaultId = state.defaultProviderId;
		if (!nextDefaultId || !nextProviders.some((p) => p.id === nextDefaultId)) {
			nextDefaultId = provider.id;
		}

		persistProviderSettings(nextProviders, nextDefaultId);

		return {
			...state,
			providers: nextProviders,
			defaultProviderId: nextDefaultId,
		};
	});

	return { error: null, providerId: id };
}

export async function hydrateSystemPromptFromDb() {
	if (typeof window === "undefined") return;

	try {
		const { APP_SETTINGS_ID, appSettingsCollection } =
			await loadAppSettingsModule();
		await appSettingsCollection.preload();
		const settings = appSettingsCollection.get(APP_SETTINGS_ID);
		if (!settings) return;

		translateStore.setState((state) => {
			if (state.systemPrompt === settings.systemPrompt) return state;
			return { ...state, systemPrompt: settings.systemPrompt };
		});
	} catch (err) {
		console.error("[app-settings] hydrate failed", err);
	}
}

export async function saveSystemPrompt(nextSystemPrompt: string) {
	const prevSystemPrompt = translateStore.state.systemPrompt;
	patchTranslateState({ systemPrompt: nextSystemPrompt });

	if (typeof window === "undefined") return;

	try {
		const { APP_SETTINGS_ID, appSettingsCollection } =
			await loadAppSettingsModule();
		await appSettingsCollection.preload();
		const existing = appSettingsCollection.get(APP_SETTINGS_ID);
		const now = Date.now();

		const tx = existing
			? appSettingsCollection.update(APP_SETTINGS_ID, (draft) => {
					draft.systemPrompt = nextSystemPrompt;
					draft.updatedAt = now;
				})
			: appSettingsCollection.insert({
					id: APP_SETTINGS_ID,
					systemPrompt: nextSystemPrompt,
					updatedAt: now,
				});

		await tx.isPersisted.promise;
	} catch (err) {
		patchTranslateState({ systemPrompt: prevSystemPrompt });
		throw err;
	}
}

export function setLeftText(leftText: string) {
	patchTranslateState({ leftText });
}

export function setDebouncedLeftText(debouncedLeftText: string) {
	patchTranslateState({ debouncedLeftText });
}

export function triggerTranslateNow() {
	setDebouncedLeftText(translateStore.state.leftText);
}

export function setRightText(rightText: string) {
	patchTranslateState({ rightText });
}

export function setIsTranslating(isTranslating: boolean) {
	patchTranslateState({ isTranslating });
}

export function setTranslateError(translateError: string) {
	patchTranslateState({ translateError });
}

export function setSourceLang(nextSourceLang: Lang) {
	translateStore.setState((state) => {
		if (state.leftLang === nextSourceLang) return state;
		if (state.rightLang === nextSourceLang) return state;

		const nextState = {
			...state,
			leftLang: nextSourceLang,
			debouncedLeftText: state.leftText,
		};

		persistTranslateLangPair(nextState.leftLang, nextState.rightLang);
		return nextState;
	});
}

export function setTargetLang(nextTargetLang: Lang) {
	translateStore.setState((state) => {
		if (state.rightLang === nextTargetLang) return state;
		if (state.leftLang === nextTargetLang) return state;

		const nextState = {
			...state,
			rightLang: nextTargetLang,
			debouncedLeftText: state.leftText,
		};

		persistTranslateLangPair(nextState.leftLang, nextState.rightLang);
		return nextState;
	});
}

export function swapTranslateLanguages() {
	translateStore.setState((state) => {
		const nextLeftLang = state.rightLang;
		const nextRightLang = state.leftLang;

		const shouldSwapTexts = Boolean(state.rightText.trim());
		const nextLeftText = shouldSwapTexts ? state.rightText : state.leftText;
		const nextRightText = shouldSwapTexts ? state.leftText : state.rightText;

		const nextState = {
			...state,
			leftLang: nextLeftLang,
			rightLang: nextRightLang,
			leftText: nextLeftText,
			rightText: nextRightText,
			debouncedLeftText: nextLeftText,
		};

		persistTranslateLangPair(nextState.leftLang, nextState.rightLang);
		return nextState;
	});
}

function createAdapter(provider: AIProvider): AIAdapter {
	switch (provider.type) {
		case "openai": {
			const key = provider.apiKey?.trim() ?? "";
			if (!key) {
				throw new Error(`${I18N_KEY_PREFIX}errors.openaiApiKeyMissing`);
			}
			const baseURL = provider.baseUrl?.trim();
			return createOpenAI(key, baseURL ? { baseURL } : undefined);
		}
		case "anthropic": {
			const key = provider.apiKey?.trim() ?? "";
			if (!key) {
				throw new Error(`${I18N_KEY_PREFIX}errors.anthropicApiKeyMissing`);
			}
			return createAnthropic(key);
		}
		case "gemini": {
			const key = provider.apiKey?.trim() ?? "";
			if (!key) {
				throw new Error(`${I18N_KEY_PREFIX}errors.geminiApiKeyMissing`);
			}
			return createGemini(key);
		}
		case "ollama": {
			const host = provider.baseUrl?.trim();
			return createOllama(host || undefined);
		}
	}
}

async function translateViaProvider(options: {
	provider: AIProvider;
	text: string;
	sourceLang: Lang;
	targetLang: Lang;
	systemPrompt: string;
	abortController?: AbortController;
}): Promise<string> {
	const {
		provider,
		text,
		sourceLang,
		targetLang,
		systemPrompt,
		abortController,
	} = options;
	const model = provider.model;
	const adapter = createAdapter(provider);

	const userPrompt = [
		`请将下面的文本从「${langLabel[sourceLang]}」翻译成「${langLabel[targetLang]}」。`,
		"",
		"原文：",
		text,
	].join("\n");

	const messages = systemPrompt.trim()
		? ([
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			] as const)
		: ([{ role: "user", content: userPrompt }] as const);

	const stream = chat({
		adapter,
		model,
		messages,
		options: {
			temperature: 0.2,
		},
		abortController,
	});

	let output = "";

	for await (const chunk of stream) {
		if (abortController?.signal.aborted) {
			throw new Error(`${I18N_KEY_PREFIX}errors.translationCanceled`);
		}
		if (chunk.type === "error") {
			throw new Error(
				chunk.error.message || `${I18N_KEY_PREFIX}errors.aiRequestFailed`,
			);
		}
		if (chunk.type === "content") {
			output = chunk.content ?? "";
		}
	}

	return output.trim();
}

let unsubscribeEffects: (() => void) | null = null;
let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let translateAbortController: AbortController | null = null;
let translateReqId = 0;

function abortOngoingTranslation() {
	translateAbortController?.abort();
	translateAbortController = null;
}

export function stopTranslateEffects() {
	if (!unsubscribeEffects) return;

	unsubscribeEffects();
	unsubscribeEffects = null;

	if (debounceTimer) {
		globalThis.clearTimeout(debounceTimer);
		debounceTimer = null;
	}

	abortOngoingTranslation();
	setIsTranslating(false);
}

export function startTranslateEffects() {
	if (unsubscribeEffects) return;

	unsubscribeEffects = translateStore.subscribe(() => {
		const state = translateStore.state;
		const prevState = translateStore.prevState;

		if (prevState && state.leftText !== prevState.leftText) {
			if (debounceTimer) {
				globalThis.clearTimeout(debounceTimer);
				debounceTimer = null;
			}

			debounceTimer = globalThis.setTimeout(() => {
				setDebouncedLeftText(translateStore.state.leftText);
			}, TRANSLATE_DEBOUNCE_MS);
		}

		const didTranslateInputsChange =
			!prevState ||
			state.providers !== prevState.providers ||
			state.defaultProviderId !== prevState.defaultProviderId ||
			state.systemPrompt !== prevState.systemPrompt ||
			state.debouncedLeftText !== prevState.debouncedLeftText ||
			state.leftLang !== prevState.leftLang ||
			state.rightLang !== prevState.rightLang;

		if (!didTranslateInputsChange) return;

		const activeProvider = getActiveProvider(state);
		if (!activeProvider) {
			abortOngoingTranslation();
			setIsTranslating(false);
			setTranslateError("");
			return;
		}

		const key = activeProvider.apiKey?.trim() ?? "";
		if (requiresApiKey(activeProvider.type) && !key) {
			abortOngoingTranslation();
			setIsTranslating(false);
			setTranslateError("");
			return;
		}

		if (!state.debouncedLeftText.trim()) {
			abortOngoingTranslation();
			setIsTranslating(false);
			setTranslateError("");
			setRightText("");
			return;
		}

		if (state.leftLang === state.rightLang) {
			abortOngoingTranslation();
			setIsTranslating(false);
			setTranslateError("");
			setRightText(state.debouncedLeftText);
			return;
		}

		abortOngoingTranslation();
		const controller = new AbortController();
		translateAbortController = controller;

		const reqId = ++translateReqId;
		setIsTranslating(true);
		setTranslateError("");

		const sourceLang = state.leftLang;
		const targetLang = state.rightLang;
		const requestText = state.debouncedLeftText;
		const providerSnapshot = activeProvider;
		const systemPromptSnapshot = state.systemPrompt;

		translateViaProvider({
			provider: providerSnapshot,
			text: requestText,
			sourceLang,
			targetLang,
			systemPrompt: systemPromptSnapshot,
			abortController: controller,
		})
			.then((translated) => {
				if (controller.signal.aborted) return;
				if (translateReqId !== reqId) return;
				setRightText(translated);
				try {
					addTranslateHistory({
						sourceLang,
						targetLang,
						sourceText: requestText,
						translatedText: translated,
					});
				} catch (err) {
					console.error("[translate-history] insert failed", err);
				}
			})
			.catch((err) => {
				if (controller.signal.aborted) return;
				if (translateReqId !== reqId) return;
				const msg =
					err instanceof Error && err.message
						? err.message
						: `${I18N_KEY_PREFIX}errors.translationFailed`;
				setTranslateError(msg);
			})
			.finally(() => {
				if (controller.signal.aborted) return;
				if (translateReqId !== reqId) return;
				setIsTranslating(false);
			});
	});
}

export const __test__ = {
	translateViaProvider,
} as const;
