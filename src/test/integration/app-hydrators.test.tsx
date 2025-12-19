import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("app hydrators integration", () => {
	beforeEach(() => {
		vi.resetModules();
		document.documentElement.lang = "";
	});

	it("AppI18nHydrator applies route language and persists", async () => {
		const [{ AppI18nHydrator }, { appI18n, APP_LANGUAGE_STORAGE_KEY }] =
			await Promise.all([
				import("@/components/AppI18nHydrator"),
				import("@/lib/app-i18n"),
			]);

		localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, "zh");

		render(<AppI18nHydrator routeLang="en" />);

		await waitFor(() => {
			expect(appI18n.language).toBe("en");
		});

		expect(localStorage.getItem(APP_LANGUAGE_STORAGE_KEY)).toBe("en");
		expect(document.documentElement.lang).toBe("en");
	});

	it("AppSettingsHydrator loads providers, lang pair, and system prompt", async () => {
		const [
			{ AppSettingsHydrator },
			{
				translateStore,
				AI_PROVIDERS_STORAGE_KEY,
				AI_DEFAULT_PROVIDER_ID_STORAGE_KEY,
				TRANSLATE_LANG_PAIR_STORAGE_KEY,
			},
			{ appSettingsCollection, APP_SETTINGS_ID },
		] = await Promise.all([
			import("@/components/AppSettingsHydrator"),
			import("@/stores/translateStore"),
			import("@/db/appSettingsCollection"),
		]);

		const providers = [
			{
				id: "p1",
				type: "openai",
				name: "OpenAI",
				model: "gpt-4.1-mini",
				apiKey: "sk-test",
				baseUrl: "https://example.com",
			},
			{
				id: "p2",
				type: "ollama",
				name: "Ollama",
				model: "llama3",
				baseUrl: "http://localhost:11434",
			},
		];

		localStorage.setItem(AI_PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
		localStorage.setItem(AI_DEFAULT_PROVIDER_ID_STORAGE_KEY, "p2");
		localStorage.setItem(
			TRANSLATE_LANG_PAIR_STORAGE_KEY,
			JSON.stringify({ sourceLang: "en", targetLang: "zh" }),
		);

		const tx = appSettingsCollection.insert({
			id: APP_SETTINGS_ID,
			systemPrompt: "CUSTOM PROMPT",
			updatedAt: 123,
		});
		await tx.isPersisted.promise;

		render(<AppSettingsHydrator />);

		await waitFor(() => {
			expect(translateStore.state.systemPrompt).toBe("CUSTOM PROMPT");
		});

		expect(translateStore.state.providers).toHaveLength(2);
		expect(translateStore.state.defaultProviderId).toBe("p2");
		expect(translateStore.state.leftLang).toBe("en");
		expect(translateStore.state.rightLang).toBe("zh");
	});
});
