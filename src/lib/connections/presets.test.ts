import { describe, expect, it } from "vitest";

import {
	CONFIGURABLE_PROVIDER_IDS,
	PROVIDER_PRESETS,
	presetDefaults,
} from "./presets";

describe("connection presets", () => {
	it("does not offer browser-native providers for manual creation", () => {
		expect(CONFIGURABLE_PROVIDER_IDS).not.toContain("builtin-translator");
		expect(CONFIGURABLE_PROVIDER_IDS).not.toContain("builtin-multimodal");
		expect(PROVIDER_PRESETS.map(({ provider }) => provider)).not.toEqual(
			expect.arrayContaining(["builtin-translator", "builtin-multimodal"]),
		);
	});

	it("has no editable endpoint or model defaults for built-in providers", () => {
		expect(presetDefaults("builtin-translator")).toEqual({
			endpoint: "",
			models: [],
			capabilities: { text: true, vision: false },
		});
		expect(presetDefaults("builtin-multimodal")).toEqual({
			endpoint: "",
			models: [],
			capabilities: { text: true, vision: false },
		});
	});
});
