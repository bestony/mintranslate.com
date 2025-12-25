// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { appI18n, detectAppLanguage, setAppLanguage } from "@/lib/app-i18n";

describe("app-i18n (SSR)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("falls back to default language when window is undefined", () => {
		expect(detectAppLanguage()).toBe("en");
	});

	it("handles missing navigator when window is present", () => {
		vi.stubGlobal("window", {
			localStorage: undefined,
			navigator: undefined,
		} as never);

		expect(detectAppLanguage()).toBe("en");
	});

	it("setAppLanguage no-ops when window is undefined", async () => {
		// Ensure we are truly in SSR mode for this test.
		vi.unstubAllGlobals();
		vi.spyOn(appI18n, "changeLanguage").mockResolvedValue(appI18n.t);

		await expect(setAppLanguage("en")).resolves.toBeUndefined();
		expect(appI18n.changeLanguage).toHaveBeenCalledWith("en");
	});
});
