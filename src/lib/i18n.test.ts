import { describe, expect, it } from "vitest";

import { i18n } from "@/lib/i18n";

describe("docs i18n", () => {
	it("exposes defaultLanguage and languages", () => {
		expect(i18n.defaultLanguage).toBe("en");
		expect(i18n.languages).toEqual(["en", "zh"]);
	});
});

