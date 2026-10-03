import { describe, expect, it } from "vitest";

import { AUTO_DETECT } from "#/lib/languages";
import { languageChipLabel, selectedSourceLanguage } from "./LanguagePicker";

describe("language chip labels", () => {
	it("shows the detected language for the auto-detect chip", () => {
		expect(languageChipLabel(AUTO_DETECT, "zh-Hans")).toBe(
			"中文（简体） - 检测到的语言",
		);
	});

	it("keeps the auto-detect label before detection", () => {
		expect(languageChipLabel(AUTO_DETECT)).toBe("检测语言");
	});

	it("can mark a concrete language when requested", () => {
		expect(languageChipLabel("en", true)).toBe("英语 - 检测到的语言");
	});

	it("highlights a detected language when it is in the quick row", () => {
		expect(
			selectedSourceLanguage(AUTO_DETECT, "zh-Hans", ["ja", "zh-Hans"]),
		).toBe("zh-Hans");
	});

	it("keeps auto-detect selected when the result is not visible", () => {
		expect(selectedSourceLanguage(AUTO_DETECT, "zh-Hans", ["ja"])).toBe(
			AUTO_DETECT,
		);
	});
});
