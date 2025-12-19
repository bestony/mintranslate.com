import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18N_KEY_PREFIX } from "@/lib/app-i18n";

const chatMock = vi.fn();
const createOpenAIMock = vi.fn();
const createAnthropicMock = vi.fn();
const createGeminiMock = vi.fn();
const createOllamaMock = vi.fn();

const addTranslateHistoryMock = vi.fn();

const appSettingsCollectionMock = {
	preload: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	insert: vi.fn(),
};

type AbortControllerLike = {
	signal: { aborted: boolean };
	abort: () => void;
};

vi.mock("@tanstack/ai", () => ({
	chat: chatMock,
}));
vi.mock("@tanstack/ai-openai", () => ({
	createOpenAI: createOpenAIMock,
}));
vi.mock("@tanstack/ai-anthropic", () => ({
	createAnthropic: createAnthropicMock,
}));
vi.mock("@tanstack/ai-gemini", () => ({
	createGemini: createGeminiMock,
}));
vi.mock("@tanstack/ai-ollama", () => ({
	createOllama: createOllamaMock,
}));

vi.mock("@/db/translateHistoryCollection", () => ({
	addTranslateHistory: addTranslateHistoryMock,
}));

vi.mock("@/db/appSettingsCollection", () => ({
	APP_SETTINGS_ID: "app",
	APP_SETTINGS_STORAGE_KEY: "mintranslate.appSettings",
	appSettingsCollection: appSettingsCollectionMock,
}));

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

async function importFreshStore() {
	vi.resetModules();

	const mod = await import("@/stores/translateStore");
	mod.stopTranslateEffects();

	mod.translateStore.setState(() => ({
		providers: [],
		defaultProviderId: "",
		systemPrompt: mod.DEFAULT_SYSTEM_PROMPT,
		leftLang: "zh",
		rightLang: "en",
		leftText: "",
		rightText: "",
		isTranslating: false,
		translateError: "",
		debouncedLeftText: "",
	}));

	return mod;
}

beforeEach(() => {
	vi.unstubAllGlobals();
	appSettingsCollectionMock.preload.mockReset();
	appSettingsCollectionMock.get.mockReset();
	appSettingsCollectionMock.update.mockReset();
	appSettingsCollectionMock.insert.mockReset();

	addTranslateHistoryMock.mockReset();
	chatMock.mockReset();
	createOpenAIMock.mockReset();
	createAnthropicMock.mockReset();
	createGeminiMock.mockReset();
	createOllamaMock.mockReset();

	window.localStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("translateStore", () => {
	it("patchTranslateState merges partial state", async () => {
		const { patchTranslateState, translateStore } = await importFreshStore();

		patchTranslateState({ leftText: "hi", translateError: "err" });
		expect(translateStore.state.leftText).toBe("hi");
		expect(translateStore.state.translateError).toBe("err");
	});

	it("triggerTranslateNow copies leftText into debouncedLeftText", async () => {
		const { setLeftText, translateStore, triggerTranslateNow } =
			await importFreshStore();

		setLeftText("hello");
		expect(translateStore.state.debouncedLeftText).toBe("");

		triggerTranslateNow();
		expect(translateStore.state.debouncedLeftText).toBe("hello");
	});

	it("hydrateProviderSettingsFromStorage parses providers and resolves default id", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(
			AI_PROVIDERS_STORAGE_KEY,
			JSON.stringify([
				{ id: "p1", type: "openai", name: "OpenAI", model: "gpt", apiKey: "k" },
				{ id: "bad", type: "nope" },
				null,
			]),
		);
		window.localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "");

		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.providers).toHaveLength(1);
		expect(translateStore.state.defaultProviderId).toBe("p1");
	});

	it("hydrateProviderSettingsFromStorage fixes invalid default id", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(
			AI_PROVIDERS_STORAGE_KEY,
			JSON.stringify([
				{
					id: "p1",
					type: "openai",
					name: "OpenAI",
					model: "gpt",
					apiKey: "k",
				},
			]),
		);
		window.localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "missing");

		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.defaultProviderId).toBe("p1");
	});

	it("hydrateProviderSettingsFromStorage clears default id when providers are empty", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(AI_PROVIDERS_STORAGE_KEY, JSON.stringify([]));
		window.localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "missing");

		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.providers).toEqual([]);
		expect(translateStore.state.defaultProviderId).toBe("");
	});

	it("hydrateProviderSettingsFromStorage migrates legacy gemini api key", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			LEGACY_GEMINI_API_KEY_STORAGE_KEY,
			DEFAULT_MODEL_BY_PROVIDER,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "uuid-1") });
		window.localStorage.setItem(LEGACY_GEMINI_API_KEY_STORAGE_KEY, " legacy ");

		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.providers).toEqual([
			{
				id: "uuid-1",
				type: "gemini",
				name: "Gemini",
				apiKey: "legacy",
				model: DEFAULT_MODEL_BY_PROVIDER.gemini,
			},
		]);
		expect(translateStore.state.defaultProviderId).toBe("uuid-1");

		expect(window.localStorage.getItem(AI_PROVIDERS_STORAGE_KEY)).toContain(
			"uuid-1",
		);
		expect(
			window.localStorage.getItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY),
		).toBe("uuid-1");
	});

	it("hydrateProviderSettingsFromStorage ignores invalid JSON", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(AI_PROVIDERS_STORAGE_KEY, "{not-json");
		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.providers).toEqual([]);
	});

	it("hydrateProviderSettingsFromStorage ignores localStorage get errors", async () => {
		const { hydrateProviderSettingsFromStorage, translateStore } =
			await importFreshStore();

		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});

		expect(() => hydrateProviderSettingsFromStorage()).not.toThrow();
		expect(translateStore.state.providers).toEqual([]);
		expect(translateStore.state.defaultProviderId).toBe("");
	});

	it("hydrateProviderSettingsFromStorage returns empty when storage is not an array", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(AI_PROVIDERS_STORAGE_KEY, JSON.stringify({}));
		window.localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "");

		hydrateProviderSettingsFromStorage();
		expect(translateStore.state.providers).toEqual([]);
	});

	it("hydrateProviderSettingsFromStorage filters invalid providers and preserves baseUrl", async () => {
		const {
			AI_PROVIDERS_STORAGE_KEY,
			AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
			hydrateProviderSettingsFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(
			AI_PROVIDERS_STORAGE_KEY,
			JSON.stringify([
				{ id: 123, type: "openai", name: "Bad", model: "m", apiKey: "k" },
				{
					id: "p1",
					type: "openai",
					name: "OpenAI",
					model: "gpt",
					apiKey: "k",
					baseUrl: "https://example.com",
				},
			]),
		);
		window.localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "");

		hydrateProviderSettingsFromStorage();

		expect(translateStore.state.providers).toEqual([
			{
				id: "p1",
				type: "openai",
				name: "OpenAI",
				model: "gpt",
				apiKey: "k",
				baseUrl: "https://example.com",
			},
		]);
		expect(translateStore.state.defaultProviderId).toBe("p1");
	});

	it("hydrateTranslateLangPairFromStorage applies stored lang pair and debounces", async () => {
		const {
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			hydrateTranslateLangPairFromStorage,
			translateStore,
		} = await importFreshStore();

		translateStore.setState((s) => ({ ...s, leftText: "hello" }));
		window.localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang: "en", targetLang: "zh" }),
		);

		hydrateTranslateLangPairFromStorage();

		expect(translateStore.state.leftLang).toBe("en");
		expect(translateStore.state.rightLang).toBe("zh");
		expect(translateStore.state.debouncedLeftText).toBe("hello");
	});

	it("hydrateTranslateLangPairFromStorage no-ops when pair matches current state", async () => {
		const {
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			hydrateTranslateLangPairFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang: "zh", targetLang: "en" }),
		);

		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");
		expect(translateStore.state.rightLang).toBe("en");
	});

	it("hydrateTranslateLangPairFromStorage ignores invalid stored values", async () => {
		const {
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			hydrateTranslateLangPairFromStorage,
			translateStore,
		} = await importFreshStore();

		window.localStorage.removeItem(TRANSLATE_LANG_PAIR_STORAGE_KEY);
		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");
		expect(translateStore.state.rightLang).toBe("en");

		window.localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify(1),
		);
		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");

		window.localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang: "xx", targetLang: "en" }),
		);
		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");

		window.localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang: "en", targetLang: "en" }),
		);
		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");

		window.localStorage.setItem(TRANSLATE_LANG_PAIR_STORAGE_KEY, "{not-json");
		hydrateTranslateLangPairFromStorage();
		expect(translateStore.state.leftLang).toBe("zh");
	});

	it("hydrateTranslateLangPairFromStorage no-ops when localStorage is unavailable", async () => {
		const { hydrateTranslateLangPairFromStorage, translateStore } =
			await importFreshStore();

		vi.stubGlobal("localStorage", undefined);

		expect(() => hydrateTranslateLangPairFromStorage()).not.toThrow();
		expect(translateStore.state.leftLang).toBe("zh");
		expect(translateStore.state.rightLang).toBe("en");
	});

	it("setDefaultProvider validates provider id and persists settings", async () => {
		const { saveProviderFromForm, setDefaultProvider, translateStore } =
			await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p1") });
		saveProviderFromForm({
			type: "openai",
			name: "OpenAI",
			model: "gpt",
			apiKey: "k",
			baseUrl: "",
		});

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p2") });
		saveProviderFromForm({
			type: "gemini",
			name: "Gemini",
			model: "g",
			apiKey: "k",
			baseUrl: "",
		});

		expect(translateStore.state.defaultProviderId).toBe("p1");

		setDefaultProvider("p2");
		expect(translateStore.state.defaultProviderId).toBe("p2");

		setDefaultProvider("missing");
		expect(translateStore.state.defaultProviderId).toBe("p2");
	});

	it("setDefaultProvider no-ops when provider is already selected", async () => {
		const { saveProviderFromForm, setDefaultProvider, translateStore } =
			await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p1") });
		saveProviderFromForm({
			type: "openai",
			name: "OpenAI",
			model: "gpt",
			apiKey: "k",
			baseUrl: "",
		});

		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
		setItemSpy.mockClear();

		setDefaultProvider("p1");
		expect(translateStore.state.defaultProviderId).toBe("p1");
		expect(setItemSpy).not.toHaveBeenCalled();
	});

	it("deleteProvider removes provider and fixes default id", async () => {
		const { deleteProvider, translateStore } = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			providers: [
				{ id: "a", type: "openai", name: "A", model: "m", apiKey: "k" },
				{ id: "b", type: "gemini", name: "B", model: "m", apiKey: "k" },
			],
			defaultProviderId: "a",
		}));

		deleteProvider("a");
		expect(translateStore.state.providers.map((p) => p.id)).toEqual(["b"]);
		expect(translateStore.state.defaultProviderId).toBe("b");
	});

	it("deleteProvider clears default id when removing the last provider", async () => {
		const { deleteProvider, translateStore } = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "a", type: "ollama", name: "A", model: "m" }],
			defaultProviderId: "a",
		}));

		deleteProvider("a");
		expect(translateStore.state.providers).toEqual([]);
		expect(translateStore.state.defaultProviderId).toBe("");
	});

	it("saveProviderFromForm validates required fields", async () => {
		const { saveProviderFromForm } = await importFreshStore();

		expect(
			saveProviderFromForm({
				type: "openai",
				name: "   ",
				model: "gpt",
				apiKey: "k",
				baseUrl: "",
			}).error,
		).toBe("errors.providerNameRequired");

		expect(
			saveProviderFromForm({
				type: "openai",
				name: "OpenAI",
				model: "   ",
				apiKey: "k",
				baseUrl: "",
			}).error,
		).toBe("errors.modelRequired");

		expect(
			saveProviderFromForm({
				type: "openai",
				name: "OpenAI",
				model: "gpt",
				apiKey: "   ",
				baseUrl: "",
			}).error,
		).toBe("errors.apiKeyRequired");

		expect(
			saveProviderFromForm({
				type: "ollama",
				name: "Ollama",
				model: "llama3",
				apiKey: "",
				baseUrl: "http://localhost:11434",
			}).error,
		).toBeNull();
	});

	it("saveProviderFromForm ignores localStorage set errors", async () => {
		const { saveProviderFromForm, translateStore } = await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p1") });
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota exceeded");
		});

		const created = saveProviderFromForm({
			type: "openai",
			name: "OpenAI",
			model: "gpt",
			apiKey: "k",
			baseUrl: "",
		});

		expect(created.error).toBeNull();
		expect(translateStore.state.providers).toHaveLength(1);
		expect(translateStore.state.defaultProviderId).toBe("p1");
	});

	it("saveProviderFromForm falls back to Date.now + Math.random when randomUUID is unavailable", async () => {
		const { saveProviderFromForm } = await importFreshStore();

		vi.stubGlobal("crypto", {});
		vi.spyOn(Date, "now").mockReturnValue(1000);
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		const created = saveProviderFromForm({
			type: "openai",
			name: "OpenAI",
			model: "gpt",
			apiKey: "k",
			baseUrl: "",
		});

		expect(created.error).toBeNull();
		expect(created.providerId).toBe("1000-8");
	});

	it("saveProviderFromForm creates or updates providers and persists", async () => {
		const { saveProviderFromForm, translateStore } = await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p1") });
		const created = saveProviderFromForm({
			type: "openai",
			name: " OpenAI ",
			model: " gpt ",
			apiKey: " k ",
			baseUrl: " https://example.com ",
		});

		expect(created.error).toBeNull();
		expect(created.providerId).toBe("p1");
		expect(translateStore.state.providers).toEqual([
			{
				id: "p1",
				type: "openai",
				name: "OpenAI",
				model: "gpt",
				apiKey: "k",
				baseUrl: "https://example.com",
			},
		]);
		expect(translateStore.state.defaultProviderId).toBe("p1");

		const updated = saveProviderFromForm({
			id: "p1",
			type: "openai",
			name: "OpenAI 2",
			model: "gpt-4",
			apiKey: "k",
			baseUrl: "",
		});

		expect(updated.error).toBeNull();
		expect(translateStore.state.providers[0]?.name).toBe("OpenAI 2");
		expect(translateStore.state.providers[0]?.baseUrl).toBeUndefined();
	});

	it("saveProviderFromForm update keeps other providers intact", async () => {
		const { saveProviderFromForm, translateStore } = await importFreshStore();

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p1") });
		saveProviderFromForm({
			type: "openai",
			name: "OpenAI",
			model: "gpt",
			apiKey: "k",
			baseUrl: "",
		});

		vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "p2") });
		saveProviderFromForm({
			type: "gemini",
			name: "Gemini",
			model: "gemini",
			apiKey: "k2",
			baseUrl: "",
		});

		saveProviderFromForm({
			id: "p1",
			type: "openai",
			name: "OpenAI Updated",
			model: "gpt-4",
			apiKey: "k",
			baseUrl: "",
		});

		expect(translateStore.state.providers).toHaveLength(2);
		expect(translateStore.state.providers[0]?.name).toBe("OpenAI Updated");
		expect(translateStore.state.providers[1]).toEqual({
			id: "p2",
			type: "gemini",
			name: "Gemini",
			model: "gemini",
			apiKey: "k2",
			baseUrl: undefined,
		});
	});

	it("hydrateSystemPromptFromDb no-ops on SSR", async () => {
		const { hydrateSystemPromptFromDb, translateStore } =
			await importFreshStore();

		const originalWindow = globalThis.window;
		// simulate SSR
		delete (globalThis as unknown as { window?: Window }).window;

		try {
			translateStore.setState((s) => ({ ...s, systemPrompt: "x" }));
			await hydrateSystemPromptFromDb();
			expect(appSettingsCollectionMock.preload).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(globalThis, "window", {
				value: originalWindow,
				configurable: true,
			});
		}
	});

	it("hydrateSystemPromptFromDb updates store from db", async () => {
		const { hydrateSystemPromptFromDb, translateStore } =
			await importFreshStore();

		appSettingsCollectionMock.preload.mockResolvedValue(undefined);
		appSettingsCollectionMock.get.mockReturnValue({
			id: "app",
			systemPrompt: "from-db",
			updatedAt: 1,
		});

		await hydrateSystemPromptFromDb();
		expect(translateStore.state.systemPrompt).toBe("from-db");
	});

	it("hydrateSystemPromptFromDb returns when db has no settings", async () => {
		const { hydrateSystemPromptFromDb, translateStore, DEFAULT_SYSTEM_PROMPT } =
			await importFreshStore();

		appSettingsCollectionMock.preload.mockResolvedValue(undefined);
		appSettingsCollectionMock.get.mockReturnValue(null);

		const setStateSpy = vi.spyOn(translateStore, "setState");
		await hydrateSystemPromptFromDb();

		expect(setStateSpy).not.toHaveBeenCalled();
		expect(translateStore.state.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
	});

	it("hydrateSystemPromptFromDb no-ops when systemPrompt is unchanged", async () => {
		const { hydrateSystemPromptFromDb, translateStore, DEFAULT_SYSTEM_PROMPT } =
			await importFreshStore();

		appSettingsCollectionMock.preload.mockResolvedValue(undefined);
		appSettingsCollectionMock.get.mockReturnValue({
			id: "app",
			systemPrompt: DEFAULT_SYSTEM_PROMPT,
			updatedAt: 1,
		});

		await hydrateSystemPromptFromDb();
		expect(translateStore.state.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
	});

	it("hydrateSystemPromptFromDb handles errors", async () => {
		const { hydrateSystemPromptFromDb } = await importFreshStore();

		const err = new Error("boom");
		appSettingsCollectionMock.preload.mockRejectedValue(err);
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		await hydrateSystemPromptFromDb();
		expect(spy).toHaveBeenCalledWith("[app-settings] hydrate failed", err);
	});

	it("saveSystemPrompt no-ops on SSR after updating in-memory state", async () => {
		const { saveSystemPrompt, translateStore } = await importFreshStore();

		const originalWindow = globalThis.window;
		// simulate SSR
		delete (globalThis as unknown as { window?: Window }).window;

		try {
			await expect(saveSystemPrompt("next")).resolves.toBeUndefined();
			expect(translateStore.state.systemPrompt).toBe("next");
			expect(appSettingsCollectionMock.preload).not.toHaveBeenCalled();
			expect(appSettingsCollectionMock.get).not.toHaveBeenCalled();
		} finally {
			Object.defineProperty(globalThis, "window", {
				value: originalWindow,
				configurable: true,
			});
		}
	});

	it("saveSystemPrompt inserts or updates and rolls back on failure", async () => {
		const { saveSystemPrompt, translateStore } = await importFreshStore();

		appSettingsCollectionMock.preload.mockResolvedValue(undefined);
		appSettingsCollectionMock.get.mockReturnValue(null);
		vi.spyOn(Date, "now").mockReturnValue(123);
		appSettingsCollectionMock.insert.mockReturnValue({
			isPersisted: { promise: Promise.resolve() },
		});

		await saveSystemPrompt("next");
		expect(translateStore.state.systemPrompt).toBe("next");
		expect(appSettingsCollectionMock.insert).toHaveBeenCalledWith({
			id: "app",
			systemPrompt: "next",
			updatedAt: 123,
		});

		appSettingsCollectionMock.get.mockReturnValue({
			id: "app",
			systemPrompt: "next",
			updatedAt: 1,
		});
		type AppSettingsDraft = { systemPrompt: string; updatedAt: number };
		const draft: AppSettingsDraft = { systemPrompt: "next", updatedAt: 1 };
		appSettingsCollectionMock.update.mockImplementation(
			(_id: string, cb: (draftValue: AppSettingsDraft) => void) => {
				cb(draft);
				return {
					isPersisted: { promise: Promise.resolve() },
				};
			},
		);

		await saveSystemPrompt("updated");
		expect(appSettingsCollectionMock.update).toHaveBeenCalledWith(
			"app",
			expect.any(Function),
		);
		expect(draft).toEqual({ systemPrompt: "updated", updatedAt: 123 });

		const prev = translateStore.state.systemPrompt;
		const failingTx = {
			isPersisted: { promise: Promise.reject(new Error("persist failed")) },
		};
		appSettingsCollectionMock.update.mockReturnValue(failingTx);

		await expect(saveSystemPrompt("will-fail")).rejects.toBeInstanceOf(Error);
		expect(translateStore.state.systemPrompt).toBe(prev);
	});

	it("setSourceLang/setTargetLang update state and persist lang pair (ignoring storage errors)", async () => {
		const {
			setSourceLang,
			setTargetLang,
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			translateStore,
		} = await importFreshStore();

		translateStore.setState((s) => ({ ...s, leftText: "hi" }));

		setSourceLang("fr");
		expect(translateStore.state.leftLang).toBe("fr");
		expect(translateStore.state.debouncedLeftText).toBe("hi");
		expect(window.localStorage.getItem(TRANSLATE_LANG_PAIR_STORAGE_KEY)).toBe(
			JSON.stringify({ sourceLang: "fr", targetLang: "en" }),
		);

		const setItem = vi
			.spyOn(Storage.prototype, "setItem")
			.mockImplementation(() => {
				throw new Error("quota exceeded");
			});

		expect(() => setTargetLang("ja")).not.toThrow();
		expect(setItem).toHaveBeenCalled();
	});

	it("setSourceLang/setTargetLang no-op when language is unchanged or conflicting", async () => {
		const { setSourceLang, setTargetLang, translateStore } =
			await importFreshStore();

		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
		setItemSpy.mockClear();

		setSourceLang("zh");
		setSourceLang("en");
		setTargetLang("en");
		setTargetLang("zh");

		expect(translateStore.state.leftLang).toBe("zh");
		expect(translateStore.state.rightLang).toBe("en");
		expect(setItemSpy).not.toHaveBeenCalled();
	});

	it("swapTranslateLanguages swaps languages and optionally texts", async () => {
		const { swapTranslateLanguages, translateStore } = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			leftLang: "zh",
			rightLang: "en",
			leftText: "left",
			rightText: "",
		}));

		swapTranslateLanguages();
		expect(translateStore.state.leftLang).toBe("en");
		expect(translateStore.state.rightLang).toBe("zh");
		expect(translateStore.state.leftText).toBe("left");
		expect(translateStore.state.rightText).toBe("");

		translateStore.setState((s) => ({
			...s,
			leftLang: "zh",
			rightLang: "en",
			leftText: "left",
			rightText: " right ",
		}));

		swapTranslateLanguages();
		expect(translateStore.state.leftText).toBe(" right ");
		expect(translateStore.state.rightText).toBe("left");

		translateStore.setState((s) => ({ ...s, leftLang: "en", rightLang: "en" }));
		swapTranslateLanguages();
		expect(translateStore.state.leftLang).toBe("en");
		expect(translateStore.state.rightLang).toBe("en");
	});

	it("startTranslateEffects debounces leftText changes", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setLeftText,
			translateStore,
		} = await importFreshStore();

		vi.useFakeTimers();

		startTranslateEffects();
		setLeftText("a");
		setLeftText("ab");

		expect(translateStore.state.debouncedLeftText).toBe("");

		await vi.advanceTimersByTimeAsync(500);
		expect(translateStore.state.debouncedLeftText).toBe("ab");

		stopTranslateEffects();
	});

	it("stopTranslateEffects cancels pending debounce timer", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setLeftText,
			translateStore,
		} = await importFreshStore();

		vi.useFakeTimers();
		startTranslateEffects();
		setLeftText("hello");
		stopTranslateEffects();

		await vi.advanceTimersByTimeAsync(500);
		expect(translateStore.state.debouncedLeftText).toBe("");
	});

	it("startTranslateEffects clears output when input is empty", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
			rightText: "should-clear",
		}));

		startTranslateEffects();
		setDebouncedLeftText("   ");
		await flushPromises();

		expect(translateStore.state.rightText).toBe("");
		stopTranslateEffects();
	});

	it("startTranslateEffects mirrors input when source/target languages are equal", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
			leftLang: "en",
			rightLang: "en",
		}));

		startTranslateEffects();
		setDebouncedLeftText("same");
		await flushPromises();

		expect(translateStore.state.rightText).toBe("same");
		stopTranslateEffects();
	});

	it("startTranslateEffects no-ops when provider missing or api key missing", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		startTranslateEffects();
		setDebouncedLeftText("hello");
		await flushPromises();
		expect(chatMock).not.toHaveBeenCalled();

		translateStore.setState((s) => ({
			...s,
			providers: [
				{ id: "p1", type: "openai", name: "OpenAI", model: "m", apiKey: "" },
			],
			defaultProviderId: "p1",
		}));
		setDebouncedLeftText("hello");
		await flushPromises();
		expect(chatMock).not.toHaveBeenCalled();

		stopTranslateEffects();
	});

	it("runs a successful translation via OpenAI adapter and persists history", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOpenAIMock.mockReturnValue({ type: "openai-adapter" });
		chatMock.mockImplementation(
			({
				messages,
				systemPrompts,
			}: {
				messages: unknown;
				systemPrompts?: string[];
			}) => {
				expect(messages).toEqual([expect.objectContaining({ role: "user" })]);
				expect(systemPrompts).toEqual(["SYSTEM"]);

				return (async function* () {
					yield { type: "content", content: " translated " };
				})();
			},
		);

		translateStore.setState((s) => ({
			...s,
			systemPrompt: "SYSTEM",
			providers: [
				{
					id: "p1",
					type: "openai",
					name: "OpenAI",
					model: "gpt",
					apiKey: "k",
					baseUrl: " https://example.com ",
				},
			],
			defaultProviderId: "p1",
			leftLang: "zh",
			rightLang: "en",
		}));

		startTranslateEffects();
		setDebouncedLeftText("你好");
		await flushPromises();
		await flushPromises();

		expect(createOpenAIMock).toHaveBeenCalledWith("k", {
			baseURL: "https://example.com",
		});
		expect(translateStore.state.rightText).toBe("translated");
		expect(addTranslateHistoryMock).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceText: "你好",
				translatedText: "translated",
				sourceLang: "zh",
				targetLang: "en",
			}),
		);

		stopTranslateEffects();
	});

	it("uses OpenAI adapter without baseUrl when baseUrl is blank", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOpenAIMock.mockReturnValue({ type: "openai-adapter" });
		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "content", content: "ok" };
			})(),
		);

		translateStore.setState((s) => ({
			...s,
			providers: [
				{
					id: "p1",
					type: "openai",
					name: "OpenAI",
					model: "gpt",
					apiKey: "k",
					baseUrl: "   ",
				},
			],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();

		expect(createOpenAIMock).toHaveBeenCalledWith("k", undefined);
		stopTranslateEffects();
	});

	it("startTranslateEffects no-ops when already started", async () => {
		const { startTranslateEffects, stopTranslateEffects, translateStore } =
			await importFreshStore();

		const subscribeSpy = vi.spyOn(translateStore, "subscribe");

		startTranslateEffects();
		startTranslateEffects();

		expect(subscribeSpy).toHaveBeenCalledTimes(1);
		stopTranslateEffects();
	});

	it("startTranslateEffects treats unknown defaultProviderId as inactive provider", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "missing",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();

		expect(chatMock).not.toHaveBeenCalled();
		stopTranslateEffects();
	});

	it("runs a successful translation via Ollama adapter (no API key) and supports systemPrompt empty", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });
		chatMock.mockImplementation(({ messages }: { messages: unknown[] }) => {
			expect(messages).toEqual([expect.objectContaining({ role: "user" })]);

			return (async function* () {
				yield { type: "content", content: "hello" };
			})();
		});

		translateStore.setState((s) => ({
			...s,
			systemPrompt: "   ",
			providers: [
				{
					id: "p1",
					type: "ollama",
					name: "Ollama",
					model: "llama3",
					baseUrl: "",
				},
			],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();
		await flushPromises();

		expect(createOllamaMock).toHaveBeenCalledWith(undefined);
		expect(translateStore.state.rightText).toBe("hello");
		stopTranslateEffects();
	});

	it("translateViaProvider uses empty string for undefined content chunks", async () => {
		const { __test__ } = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });
		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "content", content: undefined };
			})(),
		);

		await expect(
			__test__.translateViaProvider({
				provider: { id: "o", type: "ollama", name: "Ollama", model: "m" },
				text: "hi",
				sourceLang: "en",
				targetLang: "zh",
				systemPrompt: "",
			}),
		).resolves.toBe("");
	});

	it("translateViaProvider throws when api key is missing for OpenAI/Anthropic/Gemini", async () => {
		const { __test__ } = await importFreshStore();

		await expect(
			__test__.translateViaProvider({
				provider: { id: "oai", type: "openai", name: "OpenAI", model: "gpt" },
				text: "hi",
				sourceLang: "en",
				targetLang: "zh",
				systemPrompt: "",
			}),
		).rejects.toThrow(`${I18N_KEY_PREFIX}errors.openaiApiKeyMissing`);

		await expect(
			__test__.translateViaProvider({
				provider: {
					id: "ant",
					type: "anthropic",
					name: "Anthropic",
					model: "claude",
				},
				text: "hi",
				sourceLang: "en",
				targetLang: "zh",
				systemPrompt: "",
			}),
		).rejects.toThrow(`${I18N_KEY_PREFIX}errors.anthropicApiKeyMissing`);

		await expect(
			__test__.translateViaProvider({
				provider: { id: "g", type: "gemini", name: "Gemini", model: "gemini" },
				text: "hi",
				sourceLang: "en",
				targetLang: "zh",
				systemPrompt: "",
			}),
		).rejects.toThrow(`${I18N_KEY_PREFIX}errors.geminiApiKeyMissing`);
	});

	it("creates adapters for Anthropic/Gemini and supports Ollama host", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createAnthropicMock.mockReturnValue({ type: "anthropic-adapter" });
		createGeminiMock.mockReturnValue({ type: "gemini-adapter" });
		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });

		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "content", content: "ok" };
			})(),
		);

		translateStore.setState((s) => ({
			...s,
			providers: [
				{
					id: "a",
					type: "anthropic",
					name: "Anthropic",
					model: "claude",
					apiKey: "k1",
				},
				{
					id: "g",
					type: "gemini",
					name: "Gemini",
					model: "gemini",
					apiKey: "k2",
				},
				{
					id: "o",
					type: "ollama",
					name: "Ollama",
					model: "llama3",
					baseUrl: " http://localhost:11434 ",
				},
			],
			defaultProviderId: "a",
		}));

		startTranslateEffects();

		setDebouncedLeftText("hi");
		await flushPromises();
		expect(createAnthropicMock).toHaveBeenCalledWith("k1");

		translateStore.setState((s) => ({ ...s, defaultProviderId: "g" }));
		setDebouncedLeftText("hi2");
		await flushPromises();
		expect(createGeminiMock).toHaveBeenCalledWith("k2");

		translateStore.setState((s) => ({ ...s, defaultProviderId: "o" }));
		setDebouncedLeftText("hi3");
		await flushPromises();
		expect(createOllamaMock).toHaveBeenCalledWith("http://localhost:11434");

		stopTranslateEffects();
	});

	it("handles AI stream error chunks and uses fallback message when missing", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });
		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "error", error: { message: "" } };
			})(),
		);

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();
		await flushPromises();

		expect(translateStore.state.translateError).toBe(
			`${I18N_KEY_PREFIX}errors.aiRequestFailed`,
		);
		stopTranslateEffects();
	});

	it("handles thrown non-Error rejections with generic translationFailed key", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });
		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "content", content: "" };
				throw "nope";
			})(),
		);

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();
		await flushPromises();

		expect(translateStore.state.translateError).toBe(
			`${I18N_KEY_PREFIX}errors.translationFailed`,
		);
		stopTranslateEffects();
	});

	it("ignores results from outdated translate requests (reqId mismatch)", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });

		let resolveFirst: (() => void) | null = null;
		const firstDone = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		chatMock.mockImplementationOnce(() => {
			return (async function* () {
				yield { type: "content", content: "first" };
				await firstDone;
			})();
		});
		chatMock.mockImplementationOnce(() => {
			return (async function* () {
				yield { type: "content", content: "second" };
			})();
		});

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hello");
		await flushPromises();

		setDebouncedLeftText("hello again");
		await flushPromises();
		await flushPromises();

		const resolveFirstFn = resolveFirst as (() => void) | null;
		if (resolveFirstFn) resolveFirstFn();
		await flushPromises();

		expect(translateStore.state.rightText).toBe("second");
		stopTranslateEffects();
	});

	it("ignores outdated successful results when AbortController does not mark aborted (reqId mismatch path)", async () => {
		class NoAbortController {
			signal = { aborted: false };

			abort() {}
		}

		vi.stubGlobal("AbortController", NoAbortController);

		try {
			const {
				startTranslateEffects,
				stopTranslateEffects,
				setDebouncedLeftText,
				translateStore,
			} = await importFreshStore();

			createOllamaMock.mockReturnValue({ type: "ollama-adapter" });

			let resolveFirst: (() => void) | null = null;
			const firstDone = new Promise<void>((resolve) => {
				resolveFirst = resolve;
			});

			chatMock.mockImplementationOnce(() => {
				return (async function* () {
					yield { type: "content", content: "first" };
					await firstDone;
				})();
			});
			chatMock.mockImplementationOnce(() => {
				return (async function* () {
					yield { type: "content", content: "second" };
				})();
			});

			translateStore.setState((s) => ({
				...s,
				providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
				defaultProviderId: "p1",
			}));

			startTranslateEffects();
			setDebouncedLeftText("hello");
			await flushPromises();

			setDebouncedLeftText("hello again");
			await flushPromises();
			await flushPromises();

			const resolveFirstFn = resolveFirst as (() => void) | null;
			if (resolveFirstFn) resolveFirstFn();
			await flushPromises();

			expect(translateStore.state.rightText).toBe("second");
			stopTranslateEffects();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("ignores outdated errors when AbortController does not mark aborted (reqId mismatch catch path)", async () => {
		class NoAbortController {
			signal = { aborted: false };

			abort() {}
		}

		vi.stubGlobal("AbortController", NoAbortController);

		try {
			const {
				startTranslateEffects,
				stopTranslateEffects,
				setDebouncedLeftText,
				translateStore,
			} = await importFreshStore();

			createOllamaMock.mockReturnValue({ type: "ollama-adapter" });

			let rejectFirst: ((reason?: unknown) => void) | null = null;
			const firstShouldReject = new Promise<void>((_resolve, reject) => {
				rejectFirst = reject;
			});

			chatMock.mockImplementationOnce(() => {
				return (async function* () {
					yield { type: "content", content: "first" };
					await firstShouldReject;
				})();
			});
			chatMock.mockImplementationOnce(() => {
				return (async function* () {
					yield { type: "content", content: "second" };
				})();
			});

			translateStore.setState((s) => ({
				...s,
				providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
				defaultProviderId: "p1",
			}));

			startTranslateEffects();
			setDebouncedLeftText("hello");
			await flushPromises();

			setDebouncedLeftText("hello again");
			await flushPromises();
			await flushPromises();

			const rejectFirstFn = rejectFirst as ((reason?: unknown) => void) | null;
			if (rejectFirstFn) rejectFirstFn(new Error("boom"));
			await flushPromises();

			expect(translateStore.state.translateError).toBe("");
			expect(translateStore.state.rightText).toBe("second");
			stopTranslateEffects();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("logs when translate history insert fails", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		const insertErr = new Error("insert failed");
		addTranslateHistoryMock.mockImplementation(() => {
			throw insertErr;
		});

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });
		chatMock.mockReturnValue(
			(async function* () {
				yield { type: "content", content: "translated" };
			})(),
		);

		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();
		await flushPromises();

		expect(spy).toHaveBeenCalledWith(
			"[translate-history] insert failed",
			insertErr,
		);
		stopTranslateEffects();
	});

	it("stopTranslateEffects aborts ongoing translation and leaves latest request intact", async () => {
		const {
			startTranslateEffects,
			stopTranslateEffects,
			setDebouncedLeftText,
			translateStore,
		} = await importFreshStore();

		createOllamaMock.mockReturnValue({ type: "ollama-adapter" });

		let allowStreamToContinue: (() => void) | null = null;
		const allowStreamPromise = new Promise<void>((resolve) => {
			allowStreamToContinue = resolve;
		});

		let controller: AbortControllerLike | null = null;
		chatMock.mockImplementation(
			({ abortController }: { abortController?: AbortControllerLike }) => {
				controller = abortController ?? null;
				return (async function* () {
					yield { type: "content", content: "working" };
					await allowStreamPromise;
					yield { type: "content", content: "ignored" };
				})();
			},
		);

		translateStore.setState((s) => ({
			...s,
			providers: [{ id: "p1", type: "ollama", name: "Ollama", model: "m" }],
			defaultProviderId: "p1",
		}));

		startTranslateEffects();
		setDebouncedLeftText("hi");
		await flushPromises();

		expect(translateStore.state.isTranslating).toBe(true);
		const activeController = controller as AbortControllerLike | null;
		expect(activeController).not.toBeNull();
		if (!activeController) throw new Error("Expected abort controller");
		expect(activeController.signal.aborted).toBe(false);

		stopTranslateEffects();
		const resumeStream = allowStreamToContinue as (() => void) | null;
		if (resumeStream) resumeStream();
		await flushPromises();

		expect(activeController.signal.aborted).toBe(true);
		expect(translateStore.state.isTranslating).toBe(false);
	});
});
