import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("translateHistoryCollection", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("exports stable constants", async () => {
		const mod = await import("@/db/translateHistoryCollection");

		expect(mod.TRANSLATE_HISTORY_DB_NAME).toBe("mintranslate");
		expect(mod.TRANSLATE_HISTORY_DB_STORE_NAME).toBe("translate-history");
		expect(mod.TRANSLATE_HISTORY_DB_VERSION).toBe(1);
	});

	it("clears legacy localStorage history key on module load", async () => {
		window.localStorage.setItem(
			"mintranslate.translateHistory",
			JSON.stringify({
				"1": {
					id: "1",
					createdAt: 1,
					sourceLang: "zh",
					targetLang: "en",
					sourceText: "a",
					translatedText: "b",
				},
			}),
		);

		await import("@/db/translateHistoryCollection");

		expect(
			window.localStorage.getItem("mintranslate.translateHistory"),
		).toBeNull();
	});

	it("validates history item shape", async () => {
		const { translateHistoryItemSchema } = await import(
			"@/db/translateHistoryCollection"
		);
		const parsed = translateHistoryItemSchema.parse({
			id: "1",
			createdAt: 1,
			sourceLang: "zh",
			targetLang: "en",
			sourceText: "a",
			translatedText: "b",
		});
		expect(parsed.targetLang).toBe("en");
	});

	it("generates id via crypto.randomUUID when available", async () => {
		const { addTranslateHistory, translateHistoryCollection } = await import(
			"@/db/translateHistoryCollection"
		);
		const insert = vi
			.spyOn(translateHistoryCollection, "insert")
			.mockReturnValue("ok" as never);

		vi.stubGlobal("crypto", {
			randomUUID: vi.fn(() => "uuid-1"),
		});

		const result = addTranslateHistory({
			sourceLang: "zh",
			targetLang: "en",
			sourceText: "hi",
			translatedText: "hello",
		});

		expect(result).toBe("ok");
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "uuid-1",
				sourceLang: "zh",
				targetLang: "en",
			}),
		);
	});

	it("falls back to Date.now + Math.random when crypto.randomUUID unavailable", async () => {
		const { addTranslateHistory, translateHistoryCollection } = await import(
			"@/db/translateHistoryCollection"
		);
		const insert = vi
			.spyOn(translateHistoryCollection, "insert")
			.mockReturnValue("ok" as never);

		vi.stubGlobal("crypto", {});
		vi.spyOn(Date, "now").mockReturnValue(1000);
		vi.spyOn(Math, "random").mockReturnValue(0.5);

		addTranslateHistory({
			sourceLang: "zh",
			targetLang: "en",
			sourceText: "hi",
			translatedText: "hello",
		});

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "1000-8",
				createdAt: 1000,
			}),
		);
	});

	it("respects provided id/createdAt", async () => {
		const { addTranslateHistory, translateHistoryCollection } = await import(
			"@/db/translateHistoryCollection"
		);
		const insert = vi
			.spyOn(translateHistoryCollection, "insert")
			.mockReturnValue("ok" as never);

		addTranslateHistory({
			id: "custom",
			createdAt: 42,
			sourceLang: "zh",
			targetLang: "en",
			sourceText: "hi",
			translatedText: "hello",
		});

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "custom",
				createdAt: 42,
			}),
		);
	});

	it("derives collection keys from item id", async () => {
		const { translateHistoryCollection } = await import(
			"@/db/translateHistoryCollection"
		);
		const key = translateHistoryCollection.getKeyFromItem({
			id: "1",
			createdAt: 1,
			sourceLang: "zh",
			targetLang: "en",
			sourceText: "a",
			translatedText: "b",
		});
		expect(key).toBe("1");
	});
});
