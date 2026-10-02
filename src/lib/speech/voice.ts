/**
 * Voice selection.
 *
 * The Web Speech API exposes a flat list of voices with BCP-47-ish language tags.
 * Which voice to use for a given text is entirely up to the application, and the
 * naive `voices.find(v => v.lang === code)` fails constantly in practice: a
 * `zh-Hans` document is typically served by a voice tagged `zh-CN`, and Chinese
 * variants are not interchangeable.
 *
 * Matching is therefore prefix-based with explicit preferences, and a missing
 * match is never fatal — the utterance still carries a language tag and the
 * browser picks its own default. Refusing to speak because no voice matched would
 * turn a cosmetic problem into a missing feature.
 */

/** A voice, reduced to what selection needs. */
export interface VoiceLike {
	readonly name: string;
	readonly lang: string;
	/** Present in real `SpeechSynthesisVoice`; unused for selection. */
	readonly default?: boolean;
}

/**
 * Preferred concrete language tags per base language, most preferred first.
 *
 * `zh` needs this because its script variants are distinct languages to a
 * speaker: Simplified text read by a Traditional voice sounds wrong.
 */
const PREFERRED_TAGS: Record<string, readonly string[]> = {
	"zh-Hans": ["zh-CN", "zh-SG", "zh"],
	// No bare `zh` fallback here on purpose: an unqualified Chinese voice is
	// almost always Simplified, and reading Traditional text with it is audibly
	// wrong. With no match the utterance carries `zh-TW` and the browser decides.
	"zh-Hant": ["zh-TW", "zh-HK", "zh-MO"],
	en: ["en-US", "en-GB", "en"],
	ja: ["ja-JP", "ja"],
	ko: ["ko-KR", "ko"],
	fr: ["fr-FR", "fr"],
	de: ["de-DE", "de"],
	es: ["es-ES", "es"],
	ru: ["ru-RU", "ru"],
	pt: ["pt-BR", "pt-PT", "pt"],
	ar: ["ar-SA", "ar"],
	th: ["th-TH", "th"],
};

/** Lowercase, and treat `_` as `-` (some platforms report `zh_CN`). */
function normalizeTag(tag: string): string {
	return tag.trim().toLowerCase().replace(/_/g, "-");
}

/** Preferred tags for a language code, falling back to its own base prefix. */
function preferredTagsFor(languageCode: string): readonly string[] {
	const normalized = languageCode.trim();
	const direct = PREFERRED_TAGS[normalized];
	if (direct) return direct;

	// Unknown language: match on its own base prefix.
	const base = normalizeTag(normalized).split("-")[0];
	return base === "" ? [] : [base];
}

/**
 * Whether a voice tag matches a wanted tag.
 *
 * A prefix match in either direction, so `zh` matches `zh-CN` and `zh-CN` matches
 * a voice tagged `zh`. Punctuation is normalized first.
 */
function tagMatches(voiceTag: string, wantedTag: string): boolean {
	const voice = normalizeTag(voiceTag);
	const wanted = normalizeTag(wantedTag);

	if (voice === wanted) return true;
	return voice.startsWith(`${wanted}-`) || wanted.startsWith(`${voice}-`);
}

/**
 * Pick the best voice for a language, or `undefined` when none matches.
 *
 * Ties are resolved by the order of preferences, so the result is deterministic
 * rather than dependent on the browser's voice ordering.
 */
export function selectVoice(
	voices: readonly VoiceLike[],
	languageCode: string,
): VoiceLike | undefined {
	if (voices.length === 0) return undefined;

	for (const wanted of preferredTagsFor(languageCode)) {
		// A default voice wins within the same tag: the platform considers it the
		// best rendition it has.
		const matches = voices.filter((voice) => tagMatches(voice.lang, wanted));
		if (matches.length > 0) {
			return matches.find((voice) => voice.default === true) ?? matches[0];
		}
	}

	return undefined;
}

/**
 * The language tag to put on an utterance.
 *
 * Uses a concrete preferred tag when the language is known, so the browser has a
 * better chance of picking something sensible when no explicit voice matched.
 */
export function utteranceLang(languageCode: string): string {
	const preferred = preferredTagsFor(languageCode);
	// The last entry is the bare base tag, which is the safest fallback.
	return preferred.length > 0 ? preferred[0] : languageCode;
}
