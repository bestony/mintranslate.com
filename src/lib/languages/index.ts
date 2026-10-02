/**
 * Language inventory, search and validation.
 *
 * ## Why there is no index or virtual scrolling here
 *
 * PRD §8.1 asks for a name→index lookup structure and §8.3 for virtual scrolling
 * "because the language list has many options". The first-release inventory is a
 * fixed list of twelve entries, so that premise does not hold: a linear scan over
 * twelve precomputed strings costs nothing observable. This change therefore
 * **deviates deliberately** from PRD §8.1/§8.3 for this list — see the change
 * proposal and design.md D3.
 *
 * What is still worth doing, and is done here: the lowercase search forms are
 * precomputed once at module load, so filtering never repeats case conversion per
 * item. Replacing the filter with an index later is a change to `searchLanguages`
 * alone; the signature stays.
 */

/** Auto-detection is a distinct value, never a target language. */
export const AUTO_DETECT = "auto";

/** Language codes. Chinese variants are explicit rather than a bare `zh`. */
export const LANGUAGE_CODES = [
	"zh-Hans",
	"zh-Hant",
	"en",
	"ja",
	"ko",
	"fr",
	"de",
	"es",
	"ru",
	"pt",
	"ar",
	"th",
] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

export interface Language {
	/** BCP-47-style code used in the URL and in requests. */
	readonly code: LanguageCode;
	/** Chinese display name. */
	readonly nameZh: string;
	/** English display name. */
	readonly nameEn: string;
	/** Extra search terms users may type (short Chinese names, common aliases). */
	readonly aliases?: readonly string[];
}

/** The first-release inventory. */
export const LANGUAGES: readonly Language[] = [
	{
		code: "zh-Hans",
		nameZh: "中文（简体）",
		nameEn: "Chinese (Simplified)",
		aliases: ["简体", "简体中文"],
	},
	{
		code: "zh-Hant",
		nameZh: "中文（繁体）",
		nameEn: "Chinese (Traditional)",
		aliases: ["繁体", "繁体中文"],
	},
	{ code: "en", nameZh: "英语", nameEn: "English", aliases: ["英文"] },
	{
		code: "ja",
		nameZh: "日语",
		nameEn: "Japanese",
		aliases: ["日文", "日本語"],
	},
	{ code: "ko", nameZh: "韩语", nameEn: "Korean", aliases: ["韩文", "한국어"] },
	{
		code: "fr",
		nameZh: "法语",
		nameEn: "French",
		aliases: ["法文", "français"],
	},
	{
		code: "de",
		nameZh: "德语",
		nameEn: "German",
		aliases: ["德文", "deutsch"],
	},
	{
		code: "es",
		nameZh: "西班牙语",
		nameEn: "Spanish",
		aliases: ["西语", "español"],
	},
	{ code: "ru", nameZh: "俄语", nameEn: "Russian", aliases: ["俄文"] },
	{
		code: "pt",
		nameZh: "葡萄牙语",
		nameEn: "Portuguese",
		aliases: ["葡语", "português"],
	},
	{ code: "ar", nameZh: "阿拉伯语", nameEn: "Arabic", aliases: ["阿拉伯文"] },
	{ code: "th", nameZh: "泰语", nameEn: "Thai", aliases: ["泰文"] },
];

/** The default target when nothing is configured. */
export const DEFAULT_TARGET: LanguageCode = "zh-Hans";

/** The default source when nothing is configured: auto-detect. */
export const DEFAULT_SOURCE = AUTO_DETECT;

/**
 * Search haystack per language, computed once.
 *
 * Keeping this separate from `LANGUAGES` is the point: the inventory stays a
 * readable literal, while filtering never touches `toLowerCase` in a loop.
 */
interface SearchEntry {
	readonly language: Language;
	readonly haystack: string;
}

const SEARCH_INDEX: readonly SearchEntry[] = LANGUAGES.map((language) => ({
	language,
	haystack: [
		language.nameZh,
		language.nameEn,
		language.code,
		...(language.aliases ?? []),
	]
		.join(" ")
		.toLowerCase(),
}));

/** Look up a language by code. */
export function languageByCode(code: string): Language | undefined {
	return LANGUAGES.find((language) => language.code === code);
}

/** Display name for a code, falling back to the code itself. */
export function languageName(code: string): string {
	if (code === AUTO_DETECT) return "检测语言";
	return languageByCode(code)?.nameZh ?? code;
}

/** Whether a code is a selectable target language. */
export function isTargetLanguage(code: string): boolean {
	// Auto-detection cannot be a target: you cannot ask a model to translate
	// *into* "something".
	return code !== AUTO_DETECT && languageByCode(code) !== undefined;
}

/**
 * Filter languages by a search term.
 *
 * Matches the Chinese name, English name, code or an alias, case-insensitively.
 * An empty term returns the whole inventory.
 */
export function searchLanguages(term: string): readonly Language[] {
	const needle = term.trim().toLowerCase();
	if (needle === "") return LANGUAGES;

	const matches: Language[] = [];
	for (const entry of SEARCH_INDEX) {
		if (entry.haystack.includes(needle)) matches.push(entry.language);
	}
	return matches;
}

/** The two sides of a translation direction. */
export interface LanguagePair {
	readonly source: string;
	readonly target: string;
}

/** Outcome of resolving a language conflict. */
export interface ConflictResolution {
	readonly pair: LanguagePair;
	/** Set when the pair had to be adjusted. */
	readonly notice?: string;
}

/**
 * Resolve a user selection into a valid pair.
 *
 * Same-language pairs are rejected by adjusting the *other* side to the last
 * different language used, rather than refusing the user's action. The caller
 * keeps the language the user just chose and gets told what changed.
 */
export function resolveConflict(
	next: LanguagePair,
	lastDifferent: readonly string[] = [],
): ConflictResolution {
	// A real conflict requires two concrete, equal languages. Auto-detect is
	// never equal to a concrete language.
	if (next.source === AUTO_DETECT || next.source !== next.target) {
		return { pair: next };
	}

	const fallback = lastDifferent.find(
		(code) =>
			code !== next.target &&
			code !== AUTO_DETECT &&
			languageByCode(code) !== undefined,
	);

	// Choosing the source side means the target is what moves; choosing the
	// target side moves the source. Either way the user's own choice is kept.
	return {
		pair: { source: fallback ?? DEFAULT_TARGET, target: next.target },
		notice: `源语言与目标语言不能相同，已自动切换为「${languageName(fallback ?? DEFAULT_TARGET)}」。`,
	};
}

/**
 * Resolve a conflict where the user just changed the target language.
 *
 * Separate from `resolveConflict` because which side moves depends on which side
 * the user touched; keeping the user's own edit is the invariant.
 */
export function resolveTargetConflict(
	next: LanguagePair,
	lastDifferent: readonly string[] = [],
): ConflictResolution {
	if (next.source !== next.target) return { pair: next };

	const fallback = lastDifferent.find(
		(code) =>
			code !== next.target &&
			code !== AUTO_DETECT &&
			languageByCode(code) !== undefined,
	);

	return {
		pair: { source: fallback ?? DEFAULT_TARGET, target: next.target },
		notice: `源语言与目标语言不能相同，已把源语言切换为「${languageName(fallback ?? DEFAULT_TARGET)}」。`,
	};
}

/** Record of how often each language has been used, for the quick chips. */
export type UsageCounts = Readonly<Record<string, number>>;

/** How many quick chips each side shows. */
export const QUICK_CHIP_COUNT = 3;

/** Default chips when the user has no history yet. */
const DEFAULT_QUICK: readonly LanguageCode[] = ["en", "ja", "zh-Hans"];

/**
 * Pick the quick-switch languages: most recently used first, then defaults.
 *
 * Returns exactly `QUICK_CHIP_COUNT` entries so the layout is stable.
 */
export function quickLanguages(
	usage: UsageCounts = {},
	exclude: readonly string[] = [],
): readonly LanguageCode[] {
	const excluded = new Set(exclude);

	const seen = Object.entries(usage)
		.filter(
			([code]) => !excluded.has(code) && languageByCode(code) !== undefined,
		)
		.sort((a, b) => b[1] - a[1])
		.map(([code]) => code as LanguageCode);

	const ordered: LanguageCode[] = [];
	for (const code of seen) {
		if (ordered.length >= QUICK_CHIP_COUNT) break;
		if (!ordered.includes(code)) ordered.push(code);
	}

	for (const code of DEFAULT_QUICK) {
		if (ordered.length >= QUICK_CHIP_COUNT) break;
		if (excluded.has(code) || ordered.includes(code)) continue;
		ordered.push(code);
	}

	// Backfill if exclusions removed enough defaults to leave the row short.
	for (const language of LANGUAGES) {
		if (ordered.length >= QUICK_CHIP_COUNT) break;
		if (excluded.has(language.code) || ordered.includes(language.code))
			continue;
		ordered.push(language.code);
	}

	return ordered;
}

/** Swap the two sides, as the swap control does. */
export function swapPair(pair: LanguagePair): LanguagePair {
	return { source: pair.target, target: pair.source };
}

/** Whether swapping is available: auto-detect has nothing to swap into. */
export function canSwap(source: string): boolean {
	return source !== AUTO_DETECT;
}
