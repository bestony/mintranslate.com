import { describe, expect, it } from "vitest";

import { activationBlocker, canActivate, PROVIDER_IDS } from "./model";

describe("built-in connection activation", () => {
	it("registers both built-in providers", () => {
		expect(PROVIDER_IDS).toEqual(
			expect.arrayContaining(["builtin-translator", "builtin-multimodal"]),
		);
	});

	it("allows a ready built-in connection without endpoint, model or key", () => {
		const connection = {
			provider: "builtin-translator" as const,
			endpoint: "",
			model: "",
			status: "ok" as const,
		};
		expect(canActivate(connection, false)).toBe(true);
		expect(activationBlocker(connection, false)).toBeUndefined();
	});

	it("refuses an unready built-in connection with a readable reason", () => {
		const connection = {
			provider: "builtin-multimodal" as const,
			endpoint: "",
			model: "",
			status: "failed" as const,
			statusDetail: "当前设备条件不满足内置 AI 要求。",
		};
		expect(canActivate(connection, false)).toBe(false);
		expect(activationBlocker(connection, false)).toContain("设备");
	});

	it("keeps endpoint and key checks for external providers", () => {
		const connection = {
			provider: "openai" as const,
			endpoint: "",
			model: "gpt-4o-mini",
			status: "ok" as const,
		};
		expect(activationBlocker(connection, true)).toContain("Endpoint");
	});
});
