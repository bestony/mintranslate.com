import { describe, expect, it } from "vitest";

import { formatProviderLabel } from "@/lib/provider-label";
import type { AIProvider } from "@/stores/translateStore";

describe("formatProviderLabel", () => {
	it("returns fallback when provider is missing", () => {
		expect(formatProviderLabel(null, "No provider")).toBe("No provider");
	});

	it("formats provider name and model", () => {
		const provider: AIProvider = {
			id: "p1",
			type: "openai",
			name: "OpenAI",
			model: "gpt-4.1-mini",
			apiKey: "key",
		};

		expect(formatProviderLabel(provider, "No provider")).toBe(
			"OpenAI - gpt-4.1-mini",
		);
	});
});
