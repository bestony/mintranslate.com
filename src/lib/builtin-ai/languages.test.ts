import { describe, expect, it } from "vitest";

import { LANGUAGE_CODES } from "../languages";
import {
	fromBuiltinCode,
	isPromptApiLanguage,
	promptApiLanguages,
	toBuiltinCode,
} from "./languages";

describe("Chrome Built-in AI language mappings", () => {
	it("round-trips every first-release language", () => {
		for (const code of LANGUAGE_CODES) {
			const builtin = toBuiltinCode(code);
			expect(builtin, code).toBeTypeOf("string");
			expect(fromBuiltinCode(builtin as string), code).toBe(code);
		}
	});

	it("keeps simplified and traditional Chinese distinct", () => {
		expect(toBuiltinCode("zh-Hans")).toBe("zh");
		expect(toBuiltinCode("zh-Hant")).toBe("zh-Hant");
		expect(fromBuiltinCode("zh")).toBe("zh-Hans");
		expect(fromBuiltinCode("zh-Hant")).toBe("zh-Hant");
		expect(toBuiltinCode("zh-Hans")).not.toBe(toBuiltinCode("zh-Hant"));
	});

	it("returns undefined for auto detection and unknown codes", () => {
		expect(toBuiltinCode("auto")).toBeUndefined();
		expect(toBuiltinCode("xx")).toBeUndefined();
		expect(fromBuiltinCode("xx")).toBeUndefined();
	});

	it("limits Prompt API support to its five-language subset", () => {
		expect(promptApiLanguages()).toEqual(["en", "ja", "es", "de", "fr"]);
		expect(isPromptApiLanguage("en")).toBe(true);
		expect(isPromptApiLanguage("zh-Hans")).toBe(false);
		expect(isPromptApiLanguage("zh-Hant")).toBe(false);
		expect(isPromptApiLanguage("ko")).toBe(false);
	});
});
