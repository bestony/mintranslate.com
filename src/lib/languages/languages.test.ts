import { describe, expect, it } from "vitest";

import {
	AUTO_DETECT,
	canSwap,
	DEFAULT_TARGET,
	isTargetLanguage,
	LANGUAGE_CODES,
	LANGUAGES,
	languageByCode,
	languageName,
	QUICK_CHIP_COUNT,
	quickLanguages,
	resolveConflict,
	resolveTargetConflict,
	searchLanguages,
	swapPair,
} from "./index";

describe("language inventory", () => {
	it("covers the twelve first-release languages", () => {
		expect(LANGUAGES).toHaveLength(12);
		expect(LANGUAGE_CODES).toHaveLength(12);
	});

	it("has all three fields on every entry", () => {
		for (const language of LANGUAGES) {
			expect(language.code).not.toBe("");
			expect(language.nameZh).not.toBe("");
			expect(language.nameEn).not.toBe("");
		}
	});

	it("codes are unique", () => {
		expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length);
	});

	it("uses explicit Chinese variant codes", () => {
		expect(LANGUAGE_CODES).toContain("zh-Hans");
		expect(LANGUAGE_CODES).toContain("zh-Hant");
		// A bare `zh` would be ambiguous about the script.
		expect(LANGUAGE_CODES).not.toContain("zh");
	});

	it("resolves by code", () => {
		expect(languageByCode("en")?.nameZh).toBe("英语");
		expect(languageByCode("nope")).toBeUndefined();
	});

	it("names auto-detect distinctly", () => {
		expect(languageName(AUTO_DETECT)).toBe("检测语言");
	});

	it("falls back to the code for an unknown value", () => {
		expect(languageName("xx")).toBe("xx");
	});
});

describe("search", () => {
	it("returns everything for an empty term", () => {
		expect(searchLanguages("")).toHaveLength(12);
		expect(searchLanguages("   ")).toHaveLength(12);
	});

	it("matches by Chinese name", () => {
		expect(searchLanguages("日语").map((l) => l.code)).toEqual(["ja"]);
	});

	it("matches by English name, case-insensitively", () => {
		expect(searchLanguages("english").map((l) => l.code)).toEqual(["en"]);
		expect(searchLanguages("ENGLISH").map((l) => l.code)).toEqual(["en"]);
	});

	it("matches by code", () => {
		expect(searchLanguages("zh-Hant").map((l) => l.code)).toEqual(["zh-Hant"]);
		expect(searchLanguages("zh-hant").map((l) => l.code)).toEqual(["zh-Hant"]);
	});

	it("matches by alias", () => {
		expect(searchLanguages("简体").map((l) => l.code)).toEqual(["zh-Hans"]);
		expect(searchLanguages("日文").map((l) => l.code)).toEqual(["ja"]);
	});

	it("matches substrings", () => {
		expect(searchLanguages("语").length).toBeGreaterThan(3);
	});

	it("returns an empty array when nothing matches", () => {
		expect(searchLanguages("klingon")).toEqual([]);
	});

	it("does not repeat case conversion per item while filtering", () => {
		// The haystack is precomputed at module load, so filtering cannot depend on
		// mutating the inventory; the inventory stays a plain literal.
		const before = LANGUAGES.map((l) => l.nameZh).join();
		searchLanguages("ENG");
		expect(LANGUAGES.map((l) => l.nameZh).join()).toBe(before);
	});
});

describe("target language validity", () => {
	it("rejects auto-detect as a target", () => {
		expect(isTargetLanguage(AUTO_DETECT)).toBe(false);
	});

	it("accepts concrete languages", () => {
		expect(isTargetLanguage("en")).toBe(true);
		expect(isTargetLanguage("zh-Hant")).toBe(true);
	});

	it("rejects unknown codes", () => {
		expect(isTargetLanguage("xx")).toBe(false);
	});
});

describe("conflict resolution", () => {
	it("leaves a valid pair untouched", () => {
		const result = resolveConflict({ source: "auto", target: "en" });
		expect(result.pair).toEqual({ source: "auto", target: "en" });
		expect(result.notice).toBeUndefined();
	});

	it("never treats auto as equal to a concrete language", () => {
		const result = resolveConflict({
			source: AUTO_DETECT,
			target: AUTO_DETECT,
		});
		// Auto is exempt from the equality rule; it is handled by target validity.
		expect(result.pair.source).toBe(AUTO_DETECT);
	});

	it("adjusts the source side when it equals the target", () => {
		const result = resolveConflict({ source: "en", target: "en" }, ["ja"]);
		expect(result.pair.target).toBe("en");
		expect(result.pair.source).toBe("ja");
		expect(result.notice).toBeDefined();
	});

	it("falls back to the default when there is no history", () => {
		const result = resolveConflict({ source: "en", target: "en" });
		expect(result.pair.source).toBe(DEFAULT_TARGET);
		expect(result.pair.source).not.toBe(result.pair.target);
	});

	it("skips unusable candidates in the history", () => {
		const result = resolveConflict({ source: "en", target: "en" }, [
			"en",
			AUTO_DETECT,
			"fr",
		]);
		expect(result.pair.source).toBe("fr");
	});

	it("ignores history entries that are not real languages", () => {
		const result = resolveConflict({ source: "en", target: "en" }, [
			"bogus",
			"de",
		]);
		expect(result.pair.source).toBe("de");
	});

	it("keeps the user target and moves the source for a target change", () => {
		const result = resolveTargetConflict({ source: "en", target: "en" }, [
			"ja",
		]);
		// The user just picked the target, so their choice wins.
		expect(result.pair.target).toBe("en");
		expect(result.pair.source).toBe("ja");
		expect(result.notice).toContain("源语言");
	});

	it("resolves a target conflict without history", () => {
		const result = resolveTargetConflict({ source: "fr", target: "fr" });
		expect(result.pair.target).toBe("fr");
		expect(result.pair.source).not.toBe(result.pair.target);
	});
});

describe("quick languages", () => {
	it("returns exactly three chips", () => {
		expect(quickLanguages()).toHaveLength(QUICK_CHIP_COUNT);
		expect(quickLanguages({ ru: 9 })).toHaveLength(QUICK_CHIP_COUNT);
	});

	it("ranks by usage count", () => {
		const chips = quickLanguages({ ko: 5, de: 1 });
		expect(chips[0]).toBe("ko");
		expect(chips[1]).toBe("de");
	});

	it("falls back to defaults when there is no history", () => {
		const chips = quickLanguages();
		expect(chips).toContain("en");
	});

	it("excludes the language shown on the other side", () => {
		const chips = quickLanguages({ en: 100 }, ["en"]);
		expect(chips).not.toContain("en");
		expect(chips).toHaveLength(QUICK_CHIP_COUNT);
	});

	it("ignores unknown codes in the history", () => {
		const chips = quickLanguages({ bogus: 100 });
		expect(chips).toHaveLength(QUICK_CHIP_COUNT);
		expect(chips).not.toContain("bogus");
	});

	it("excludes the row's own current language, so it is not shown twice", () => {
		// The reported defect: the target row's label button showed 中文（简体） and the
		// chip row offered 中文（简体） again, because the call site only excluded the
		// *other* side. Excluding both sides is what removes the duplicate.
		const targetChips = quickLanguages({}, ["zh-Hans", "auto"]);
		expect(targetChips).not.toContain("zh-Hans");
		expect(targetChips).toHaveLength(QUICK_CHIP_COUNT);

		const sourceChips = quickLanguages({}, ["auto", "zh-Hans"]);
		expect(sourceChips).not.toContain("auto");
		expect(sourceChips).toHaveLength(QUICK_CHIP_COUNT);
	});

	it("keeps every chip distinct when the current language is excluded", () => {
		const chips = quickLanguages({ en: 9, ja: 5 }, ["en", "auto"]);
		expect(new Set(chips).size).toBe(chips.length);
		expect(chips).toHaveLength(QUICK_CHIP_COUNT);
	});

	it("backfills when exclusions thin the defaults", () => {
		const chips = quickLanguages({}, ["en", "ja", "zh-Hans"]);
		expect(chips).toHaveLength(QUICK_CHIP_COUNT);
		for (const code of chips)
			expect(["en", "ja", "zh-Hans"]).not.toContain(code);
	});
});

describe("swap", () => {
	it("exchanges the two sides", () => {
		expect(swapPair({ source: "en", target: "ja" })).toEqual({
			source: "ja",
			target: "en",
		});
	});

	it("is available for a concrete source", () => {
		expect(canSwap("en")).toBe(true);
	});

	it("is unavailable while auto-detecting", () => {
		// There is no concrete source language to move to the target side.
		expect(canSwap(AUTO_DETECT)).toBe(false);
	});
});
