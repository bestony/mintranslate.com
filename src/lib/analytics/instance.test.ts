import { describe, expect, it } from "vitest";

import { hasConfiguredExternalConnection } from "./instance";

function connection(provider: string, status: string) {
	return {
		id: provider,
		name: provider,
		provider,
		endpoint: provider.startsWith("builtin") ? "" : "https://example.test/v1",
		model: provider.startsWith("builtin") ? "" : "model",
		capabilities: { text: true, vision: false },
		status,
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("analytics BYOK classification", () => {
	it("does not count only built-in connections", () => {
		expect(
			hasConfiguredExternalConnection(
				JSON.stringify([
					connection("builtin-translator", "ok"),
					connection("builtin-multimodal", "ok"),
				]),
			),
		).toBe(false);
	});

	it("counts a tested external connection", () => {
		expect(
			hasConfiguredExternalConnection(
				JSON.stringify([
					connection("builtin-translator", "ok"),
					connection("openai", "ok"),
				]),
			),
		).toBe(true);
	});

	it("does not count an untested external connection", () => {
		expect(
			hasConfiguredExternalConnection(
				JSON.stringify([connection("openai", "untested")]),
			),
		).toBe(false);
	});
});
