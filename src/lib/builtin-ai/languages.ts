/**
 * Language-code adapters for Chrome Built-in AI.
 *
 * The application keeps explicit Chinese variants in its language inventory,
 * while Translator uses `zh` for simplified Chinese. Prompt API support is a
 * deliberately smaller set and must be checked before a call is made.
 */

import { AUTO_DETECT, LANGUAGE_CODES, type LanguageCode } from "../languages";

/** Translator language codes for the first-release language inventory. */
export const TRANSLATOR_LANGUAGE_CODES = {
	"zh-Hans": "zh",
	"zh-Hant": "zh-Hant",
	en: "en",
	ja: "ja",
	ko: "ko",
	fr: "fr",
	de: "de",
	es: "es",
	ru: "ru",
	pt: "pt",
	ar: "ar",
	th: "th",
} as const satisfies Record<LanguageCode, string>;

/** Languages accepted by the Prompt API in the first release. */
export const PROMPT_API_LANGUAGE_CODES = [
	"en",
	"ja",
	"es",
	"de",
	"fr",
] as const;

export type PromptApiLanguageCode = (typeof PROMPT_API_LANGUAGE_CODES)[number];

const TRANSLATOR_TO_INTERNAL = new Map<string, LanguageCode>(
	Object.entries(TRANSLATOR_LANGUAGE_CODES).map(([internal, builtin]) => [
		builtin,
		internal as LanguageCode,
	]),
);

const PROMPT_API_LANGUAGES = new Set<string>(PROMPT_API_LANGUAGE_CODES);

/** Convert an internal language code to a Chrome Translator code. */
export function toBuiltinCode(code: string): string | undefined {
	if (code === AUTO_DETECT) return undefined;
	return LANGUAGE_CODES.includes(code as LanguageCode)
		? TRANSLATOR_LANGUAGE_CODES[code as LanguageCode]
		: undefined;
}

/** Convert a Chrome Translator code back to an internal language code. */
export function fromBuiltinCode(code: string): LanguageCode | undefined {
	return TRANSLATOR_TO_INTERNAL.get(code);
}

/** Whether an internal or Chrome code is accepted by Prompt API. */
export function isPromptApiLanguage(code: string): boolean {
	return PROMPT_API_LANGUAGES.has(code);
}

/** Compatibility name for callers that describe this as a support check. */
export const isPromptLanguageSupported = isPromptApiLanguage;

/** Compatibility name for callers that use the shorter API terminology. */
export const isPromptLanguage = isPromptApiLanguage;

/** Return the supported Prompt API subset as an immutable array. */
export function promptApiLanguages(): readonly PromptApiLanguageCode[] {
	return PROMPT_API_LANGUAGE_CODES;
}
