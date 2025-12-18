import { describe, expect, it } from "vitest";

import { DEFAULT_DOCS_LANGUAGE, detectDocsLanguage } from "@/lib/docs-language";

describe("docs-language", () => {
	it("returns default docs language for empty or unsupported inputs", () => {
		expect(detectDocsLanguage(undefined)).toBe(DEFAULT_DOCS_LANGUAGE);
		expect(detectDocsLanguage(null)).toBe(DEFAULT_DOCS_LANGUAGE);
		expect(detectDocsLanguage("")).toBe(DEFAULT_DOCS_LANGUAGE);
		expect(detectDocsLanguage("fr")).toBe(DEFAULT_DOCS_LANGUAGE);
		expect(detectDocsLanguage("de-DE")).toBe(DEFAULT_DOCS_LANGUAGE);
	});

	it("normalizes supported language values", () => {
		expect(detectDocsLanguage("en")).toBe("en");
		expect(detectDocsLanguage("EN")).toBe("en");
		expect(detectDocsLanguage("en-US")).toBe("en");

		expect(detectDocsLanguage("zh")).toBe("zh");
		expect(detectDocsLanguage("ZH")).toBe("zh");
		expect(detectDocsLanguage("zh-CN")).toBe("zh");
	});
});
