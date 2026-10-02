/**
 * Speech rate tiers.
 *
 * Three named tiers rather than a numeric slider: the PRD asks for "normal /
 * slow / slower" and named tiers are what the interface shows, so the mapping to
 * the `rate` value lives here and nowhere else.
 */

/** Rate tiers, in the order the interface presents them. */
export const SPEECH_RATES = ["normal", "slow", "slower"] as const;

export type SpeechRate = (typeof SPEECH_RATES)[number];

/**
 * `rate` values for the Web Speech API.
 *
 * 1 is the platform default. The slower tiers are deliberately mild: values
 * below roughly 0.6 become hard to follow for most voices, which defeats the
 * purpose of slowing down.
 */
const RATE_VALUES: Record<SpeechRate, number> = {
	normal: 1,
	slow: 0.8,
	slower: 0.6,
};

/** Default tier when nothing has been chosen. */
export const DEFAULT_SPEECH_RATE: SpeechRate = "normal";

/** Whether a value is a known tier. */
export function isSpeechRate(value: unknown): value is SpeechRate {
	return (
		typeof value === "string" &&
		(SPEECH_RATES as readonly string[]).includes(value)
	);
}

/** The `rate` value for a tier. */
export function rateValue(rate: SpeechRate): number {
	return RATE_VALUES[rate];
}

/** Display label for a tier. */
export function rateLabel(rate: SpeechRate): string {
	switch (rate) {
		case "normal":
			return "正常";
		case "slow":
			return "慢";
		case "slower":
			return "更慢";
	}
}

/** Sample text used by the per-tier preview buttons. */
export const RATE_PREVIEW_TEXT = "这是一段语速试听示例。";
