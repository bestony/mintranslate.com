import { describe, expect, it, vi } from "vitest";

import {
	addTranslateHistory,
	TRANSLATE_HISTORY_STORAGE_KEY,
	translateHistoryCollection,
	translateHistoryItemSchema,
} from "@/db/translateHistoryCollection";

describe("translateHistoryCollection", () => {
	it("exports stable constants", () => {
		expect(TRANSLATE_HISTORY_STORAGE_KEY).toBe("mintranslate.translateHistory");
	});

	it("validates history item shape", () => {
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

	it("generates id via crypto.randomUUID when available", () => {
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

	it("falls back to Date.now + Math.random when crypto.randomUUID unavailable", () => {
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

	it("respects provided id/createdAt", () => {
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
});

