import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { en } from "@/locales/en";
import { zh } from "@/locales/zh";

export const APP_LANGUAGE_STORAGE_KEY = "mintranslate.uiLanguage" as const;
export const I18N_KEY_PREFIX = "i18n:" as const;

export type AppLanguage = "en" | "zh";

const SUPPORTED_LANGUAGES: readonly AppLanguage[] = ["en", "zh"] as const;
const DEFAULT_LANGUAGE: AppLanguage = "zh";

export const appI18n = i18next.createInstance();

void appI18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		zh: { translation: zh },
	},
	supportedLngs: [...SUPPORTED_LANGUAGES],
	fallbackLng: DEFAULT_LANGUAGE,
	defaultNS: "translation",
	ns: ["translation"],
	lng: DEFAULT_LANGUAGE,
	initImmediate: false,
	interpolation: {
		escapeValue: false,
	},
	react: {
		useSuspense: false,
	},
});

export function normalizeAppLanguage(
	value: string | null | undefined,
): AppLanguage | null {
	if (!value) return null;
	const lowered = value.toLowerCase();
	if (lowered === "en" || lowered.startsWith("en-")) return "en";
	if (lowered === "zh" || lowered.startsWith("zh-")) return "zh";
	return null;
}

export function detectAppLanguage(routeLang?: string): AppLanguage {
	const normalizedRouteLang = normalizeAppLanguage(routeLang);
	if (normalizedRouteLang) return normalizedRouteLang;

	if (typeof window === "undefined") return DEFAULT_LANGUAGE;

	const stored = normalizeAppLanguage(
		window.localStorage?.getItem(APP_LANGUAGE_STORAGE_KEY) ?? null,
	);
	if (stored) return stored;

	const navigatorLang = normalizeAppLanguage(
		window.navigator?.language ?? null,
	);
	return navigatorLang ?? DEFAULT_LANGUAGE;
}

export function toHtmlLang(lang: AppLanguage) {
	return lang === "zh" ? "zh-CN" : "en";
}

export async function setAppLanguage(lang: AppLanguage) {
	await appI18n.changeLanguage(lang);

	if (typeof window === "undefined") return;

	try {
		window.localStorage?.setItem(APP_LANGUAGE_STORAGE_KEY, lang);
	} catch {
		// ignore
	}

	try {
		window.document.documentElement.lang = toHtmlLang(lang);
	} catch {
		// ignore
	}
}

export function isI18nKey(
	value: string,
): value is `${typeof I18N_KEY_PREFIX}${string}` {
	return value.startsWith(I18N_KEY_PREFIX);
}
