import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	APP_LANGUAGE_STORAGE_KEY,
	I18N_KEY_PREFIX,
	appI18n,
	detectAppLanguage,
	isI18nKey,
	normalizeAppLanguage,
	setAppLanguage,
	toHtmlLang,
} from "@/lib/app-i18n";

describe("app-i18n", () => {
	beforeEach(() => {
		vi.spyOn(appI18n, "changeLanguage").mockResolvedValue(appI18n.t);
	});

	describe("normalizeAppLanguage", () => {
		it("returns null for empty inputs", () => {
			expect(normalizeAppLanguage(undefined)).toBeNull();
			expect(normalizeAppLanguage(null)).toBeNull();
			expect(normalizeAppLanguage("")).toBeNull();
		});

		it("normalizes english", () => {
			expect(normalizeAppLanguage("en")).toBe("en");
			expect(normalizeAppLanguage("EN")).toBe("en");
			expect(normalizeAppLanguage("en-US")).toBe("en");
			expect(normalizeAppLanguage("en-us")).toBe("en");
		});

		it("normalizes chinese", () => {
			expect(normalizeAppLanguage("zh")).toBe("zh");
			expect(normalizeAppLanguage("ZH")).toBe("zh");
			expect(normalizeAppLanguage("zh-CN")).toBe("zh");
			expect(normalizeAppLanguage("zh-cn")).toBe("zh");
		});

		it("returns null for unsupported languages", () => {
			expect(normalizeAppLanguage("fr")).toBeNull();
			expect(normalizeAppLanguage("de-DE")).toBeNull();
		});
	});

	describe("detectAppLanguage", () => {
		it("prefers route lang when provided", () => {
			window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, "zh");
			expect(detectAppLanguage("en")).toBe("en");
			expect(detectAppLanguage("en-US")).toBe("en");
		});

		it("falls back to default language when window is undefined", () => {
			const originalWindow = globalThis.window;
			// @ts-expect-error - simulate SSR
			delete (globalThis as unknown as { window?: Window }).window;

			try {
				expect(detectAppLanguage(undefined)).toBe("zh");
			} finally {
				Object.defineProperty(globalThis, "window", {
					value: originalWindow,
					configurable: true,
				});
			}
		});

		it("uses stored language when available", () => {
			window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, "en");
			expect(detectAppLanguage()).toBe("en");
		});

		it("uses navigator language when nothing stored", () => {
			window.localStorage.removeItem(APP_LANGUAGE_STORAGE_KEY);

			const originalNavigator = window.navigator;
			Object.defineProperty(window, "navigator", {
				value: { ...originalNavigator, language: "en-US" },
				configurable: true,
			});

			try {
				expect(detectAppLanguage()).toBe("en");
			} finally {
				Object.defineProperty(window, "navigator", {
					value: originalNavigator,
					configurable: true,
				});
			}
		});

		it("returns default language when nothing matches", () => {
			window.localStorage.removeItem(APP_LANGUAGE_STORAGE_KEY);

			const originalNavigator = window.navigator;
			Object.defineProperty(window, "navigator", {
				value: { ...originalNavigator, language: "fr-FR" },
				configurable: true,
			});

			try {
				expect(detectAppLanguage()).toBe("zh");
			} finally {
				Object.defineProperty(window, "navigator", {
					value: originalNavigator,
					configurable: true,
				});
			}
		});
	});

	describe("toHtmlLang", () => {
		it("maps app language to HTML lang", () => {
			expect(toHtmlLang("zh")).toBe("zh-CN");
			expect(toHtmlLang("en")).toBe("en");
		});
	});

	describe("setAppLanguage", () => {
		it("changes i18n language + persists to localStorage + sets document lang", async () => {
			await setAppLanguage("en");

			expect(appI18n.changeLanguage).toHaveBeenCalledWith("en");
			expect(window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY)).toBe("en");
			expect(document.documentElement.lang).toBe("en");
		});

		it("ignores localStorage errors", async () => {
			const setItem = vi
				.spyOn(window.localStorage, "setItem")
				.mockImplementation(() => {
					throw new Error("quota exceeded");
				});

			await expect(setAppLanguage("zh")).resolves.toBeUndefined();
			expect(appI18n.changeLanguage).toHaveBeenCalledWith("zh");
			expect(setItem).toHaveBeenCalled();
		});

		it("ignores document lang errors", async () => {
			const original = document.documentElement.lang;

			Object.defineProperty(document.documentElement, "lang", {
				configurable: true,
				get: () => original,
				set: () => {
					throw new Error("readonly");
				},
			});

			try {
				await expect(setAppLanguage("en")).resolves.toBeUndefined();
				expect(appI18n.changeLanguage).toHaveBeenCalledWith("en");
			} finally {
				Object.defineProperty(document.documentElement, "lang", {
					configurable: true,
					writable: true,
					value: original,
				});
			}
		});
	});

	describe("isI18nKey", () => {
		it("detects prefixed keys", () => {
			expect(isI18nKey(`${I18N_KEY_PREFIX}errors.example`)).toBe(true);
			expect(isI18nKey("errors.example")).toBe(false);
		});
	});
});

